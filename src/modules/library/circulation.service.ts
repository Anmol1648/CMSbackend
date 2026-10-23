import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { schoolDays } from '../attendance/calendar.service';
import { registerFeeSource } from '../fees/dues.service';
import { raiseLater } from '../alerts/deliver';
import { parentsOf, staffOf, studentsOf } from '../alerts/recipients';
import { LIBRARY } from './library.settings';
import { findCopy } from './books.service';
import { limitsFor, memberCard, MemberKind, myMembers, unpaidFines } from './members.service';

/**
 * The counter: issue, return, renew, lost / damaged; reservations; and fines (late, lost, damaged).
 * Students' fines go into their fees (the next instalment) or are paid at the counter (System
 * Settings → Library); staff always pay at the counter.
 */

const DAY = 86_400_000;
const plusDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const showDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

type Ref = { memberKind: string; studentId: string | null; staffId: string | null };
const whereMember = (kind: MemberKind, id: string) => (kind === 'staff' ? { memberKind: 'staff', staffId: id } : { memberKind: 'student', studentId: id });

/** Tells a member (a student and their parents, or a staff member). */
const tell = (key: string, r: Ref, vars: Record<string, string>, dedupe: string) => {
    if (r.memberKind === 'staff' && r.staffId) raiseLater(key, { member: () => staffOf([r.staffId!]) }, vars, { dedupe });
    else if (r.studentId) raiseLater(key, { member: () => studentsOf([r.studentId!]), parent: () => parentsOf([r.studentId!]) }, vars, { dedupe });
};
const nameOf = async (r: Ref) => {
    const p = r.memberKind === 'staff' ? await db.staff.findFirst({ where: { id: r.staffId! }, select: { firstName: true, lastName: true } }) : await db.student.findFirst({ where: { id: r.studentId! }, select: { firstName: true, lastName: true } });
    return p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : '';
};

/** The due date: N days on, moved to the next school day if it falls on a holiday. */
const dueDate = async (from: string, days: number) => {
    const due = plusDays(from, days);
    const open = await schoolDays(due, plusDays(due, 30), 'students');
    return open[0] ?? due;
};

/** Late days between the due date and the return (school days only, unless set otherwise), less the grace days. */
export const lateFine = async (dueOn: string, returnedOn: string) => {
    const s = await getSettings({ perDay: LIBRARY.finePerDay, grace: LIBRARY.fineGraceDays, max: LIBRARY.fineMax, holidays: LIBRARY.fineHolidays });
    if (returnedOn <= dueOn || !s.perDay) return { days: 0, amount: 0 };
    const from = plusDays(dueOn, 1);
    const days = s.holidays ? Math.round((dayDate(returnedOn).getTime() - dayDate(from).getTime()) / DAY) + 1 : (await schoolDays(from, returnedOn, 'students')).length;
    const counted = Math.max(0, days - s.grace);
    const amount = counted * s.perDay;
    return { days: counted, amount: s.max ? Math.min(amount, s.max) : amount };
};

/** Records a fine (students: into the fees or for the counter, by the setting). */
const addFine = async (r: Ref & { loanId: string | null }, kind: 'late' | 'lost' | 'damaged', amount: number, note: string, userId: string | null) => {
    if (amount <= 0) return null;
    const year = await currentYear();
    const { to } = await getSettings({ to: LIBRARY.finesTo });
    const payAt = r.memberKind === 'student' && to === 'fees' ? 'fees' : 'counter';
    const f = await db.libraryFine.create({ data: { tenantId: getTenantId()!, loanId: r.loanId, memberKind: r.memberKind, studentId: r.studentId, staffId: r.staffId, academicYearId: year?.id ?? null, kind, amount, payAt, on: dayDate(todayIST()), note, createdBy: userId } });
    tell('library_fine', r, { amount: rupees(amount), reason: note, where: payAt === 'fees' ? 'It is added to the school fees (next instalment).' : 'Please pay it at the library.', student: await nameOf(r) }, `lib-fine:${f.id}`);
    return f;
};

// ─── Issue ───────────────────────────────────────────────────────────────────

export const issueSchema = z.strictObject({
    memberKind: z.enum(['student', 'staff']),
    memberId: z.uuid(),
    accessionNo: z.string().trim().min(1).max(30),
    /** Another due date than the usual (the counter can change it). */
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Lend even though a rule says no (over the limit, overdue book, fines). */
    override: z.boolean().optional(),
});

export const issue = async (input: z.infer<typeof issueSchema>, userId: string) => {
    const kind = input.memberKind;
    const card = await memberCard(kind, input.memberId);
    if (!card.active) throw badRequest(`${card.name} is not an active ${kind === 'staff' ? 'staff member' : 'student'}`);
    const copy = await findCopy(input.accessionNo);
    const s = await getSettings({ refIssue: LIBRARY.referenceIssue, blockOverdue: LIBRARY.blockOverdue, blockFine: LIBRARY.blockFineAbove });
    if (copy.book.kind === 'reference' && !s.refIssue) throw badRequest(`${copy.book.title} is a reference book: read in the library only (System Settings → Library)`);
    if (!copy.book.isActive) throw badRequest('This title is not in use');
    const mine = await db.libraryReservation.findFirst({ where: { bookId: copy.bookId, ...whereMember(kind, input.memberId), status: { in: ['waiting', 'ready'] } } });
    if (copy.status === 'issued') throw badRequest(`${copy.accessionNo} is already lent out; take it back first`);
    if (copy.status === 'on_hold') {
        const hold = await db.libraryReservation.findFirst({ where: { copyId: copy.id, status: 'ready' } });
        if (hold && hold.id !== mine?.id) throw badRequest(`${copy.accessionNo} is kept for a member who reserved it (until ${hold.holdUntil ? showDate(isoOf(hold.holdUntil)) : 'soon'})`);
    } else if (copy.status !== 'available') throw badRequest(`${copy.accessionNo} is ${copy.status.replace('_', ' ')}`);
    // The rules (the counter can override them).
    const problems: string[] = [];
    if (card.loans.length >= card.limits.books) problems.push(`already has ${card.loans.length} book${card.loans.length === 1 ? '' : 's'} (limit ${card.limits.books}, ${card.limits.type})`);
    if (s.blockOverdue && card.loans.some((l) => l.overdue)) problems.push('has an overdue book');
    if (s.blockFine && card.fines.total > s.blockFine) problems.push(`owes ${rupees(card.fines.total)} in fines`);
    if (problems.length && !input.override) throw badRequest(`${card.name} ${problems.join(', and ')}.`, [{ field: 'override', message: problems.join('; ') }]);
    const today = todayIST();
    const due = input.dueOn ?? (await dueDate(today, card.limits.days));
    if (due < today) throw badRequest('The due date is in the past', [{ field: 'dueOn', message: 'is in the past' }]);
    const loan = await db.libraryLoan.create({ data: { tenantId: getTenantId()!, copyId: copy.id, bookId: copy.bookId, ...whereMember(kind, input.memberId), issuedOn: dayDate(today), dueOn: dayDate(due), issuedBy: userId, note: problems.length ? `Lent although: ${problems.join('; ')}` : null } });
    await db.bookCopy.update({ where: { id: copy.id }, data: { status: 'issued' } });
    if (mine) await db.libraryReservation.update({ where: { id: mine.id }, data: { status: 'issued', copyId: copy.id } });
    await recordAudit({ action: 'book_issued', entity: 'book', entityId: copy.bookId, changes: { copy: copy.accessionNo, member: card.name, due, override: problems.length ? problems : undefined } });
    return { loanId: loan.id, title: copy.book.title, accessionNo: copy.accessionNo, dueOn: due, member: await memberCard(kind, input.memberId) };
};

// ─── Return ──────────────────────────────────────────────────────────────────

export const returnSchema = z.strictObject({
    accessionNo: z.string().trim().min(1).max(30),
    /** Its condition now (a damaged one may be charged a share of its price). */
    conditionId: z.uuid().nullable().optional(),
    /** Don't charge the late fine (needs library.fines). */
    waiveLate: z.boolean().optional(),
});

/** When a copy comes back: the first member waiting for the title gets it kept for them. */
const passToNextReservation = async (copyId: string, bookId: string) => {
    const next = await db.libraryReservation.findFirst({ where: { bookId, status: 'waiting' }, orderBy: { createdAt: 'asc' } });
    if (!next) return null;
    const { hold } = await getSettings({ hold: LIBRARY.holdDays });
    const until = plusDays(todayIST(), hold);
    await db.libraryReservation.update({ where: { id: next.id }, data: { status: 'ready', copyId, readyAt: new Date(), holdUntil: dayDate(until) } });
    await db.bookCopy.update({ where: { id: copyId }, data: { status: 'on_hold' } });
    const b = await db.book.findFirst({ where: { id: bookId }, select: { title: true } });
    tell('library_reserved_ready', next, { title: b?.title ?? '', until: showDate(until), student: await nameOf(next) }, `lib-ready:${next.id}`);
    return { member: await nameOf(next), until };
};

export const returnBook = async (input: z.infer<typeof returnSchema>, userId: string, canWaive: boolean) => {
    const copy = await findCopy(input.accessionNo);
    const loan = await db.libraryLoan.findFirst({ where: { copyId: copy.id, status: 'out' } });
    if (!loan) throw badRequest(`${copy.accessionNo} isn’t lent to anyone`);
    if (input.waiveLate && !canWaive) throw forbidden('Waiving a fine needs the permission to waive fines');
    const today = todayIST();
    const late = await lateFine(isoOf(loan.dueOn), today);
    await db.libraryLoan.update({ where: { id: loan.id }, data: { status: 'returned', returnedOn: dayDate(today), returnedBy: userId } });
    const fines: { kind: string; amount: number }[] = [];
    if (late.amount && !input.waiveLate) {
        await addFine({ ...loan, loanId: loan.id }, 'late', late.amount, `${copy.book.title}: returned ${late.days} day${late.days === 1 ? '' : 's'} late`, userId);
        fines.push({ kind: 'late', amount: late.amount });
    }
    // Damaged: a share of the price, by the condition (Masters → Book condition).
    let status = 'available';
    if (input.conditionId && input.conditionId !== copy.conditionId) {
        const c = await db.masterValue.findFirst({ where: { id: input.conditionId, master: 'book_condition' }, select: { name: true, extra: true } });
        const pct = Number((c?.extra as { charge?: number } | null)?.charge ?? 0);
        const price = copy.price ?? copy.book.price ?? 0;
        if (pct > 0 && price > 0) {
            const amount = Math.round((price * pct) / 100);
            await addFine({ ...loan, loanId: loan.id }, 'damaged', amount, `${copy.book.title}: came back ${c?.name.toLowerCase()}`, userId);
            fines.push({ kind: 'damaged', amount });
        }
        if (pct >= 50) status = 'damaged';
    }
    await db.bookCopy.update({ where: { id: copy.id }, data: { status, conditionId: input.conditionId ?? copy.conditionId } });
    const held = status === 'available' ? await passToNextReservation(copy.id, copy.bookId) : null;
    await recordAudit({ action: 'book_returned', entity: 'book', entityId: copy.bookId, changes: { copy: copy.accessionNo, lateDays: late.days, fines, waived: input.waiveLate ? late.amount : undefined } });
    return { title: copy.book.title, accessionNo: copy.accessionNo, lateDays: late.days, lateFine: input.waiveLate ? 0 : late.amount, fines, heldFor: held, member: await memberCard(loan.memberKind as MemberKind, (loan.memberKind === 'staff' ? loan.staffId : loan.studentId)!) };
};

// ─── Renew ───────────────────────────────────────────────────────────────────

/** Renews a loan for the member's usual days (not when someone is waiting for it, or past its renewals). */
export const renew = async (loanId: string, userId: string, asMember: boolean) => {
    const loan = await db.libraryLoan.findFirst({ where: { id: loanId, status: 'out' }, include: { copy: { select: { accessionNo: true, book: { select: { title: true } } } } } });
    if (!loan) throw notFound('This book isn’t lent out');
    if (asMember) {
        const { online } = await getSettings({ online: LIBRARY.renewOnline });
        if (!online) throw forbidden('Renew at the library counter');
        const mine = await myMembers(userId);
        if (!mine.some((m) => m.id === (loan.staffId ?? loan.studentId))) throw forbidden();
    }
    const kind = loan.memberKind as MemberKind;
    const cls = kind === 'student' ? (await memberCard(kind, loan.studentId!)).limits : await limitsFor('staff', null);
    if (loan.renewals >= cls.renewals) throw badRequest(`Renewed ${loan.renewals} time${loan.renewals === 1 ? '' : 's'} already (limit ${cls.renewals}); please return it`);
    const today = todayIST();
    if (isoOf(loan.dueOn) < today) throw badRequest('This book is overdue: return it at the library (a late fine applies)');
    if (await db.libraryReservation.count({ where: { bookId: loan.bookId, status: 'waiting' } })) throw badRequest('Someone is waiting for this book, so it can’t be renewed');
    const due = await dueDate(today, cls.days);
    await db.libraryLoan.update({ where: { id: loanId }, data: { dueOn: dayDate(due), renewals: loan.renewals + 1, remindedOn: null } });
    await recordAudit({ action: 'book_renewed', entity: 'book', entityId: loan.bookId, changes: { copy: loan.copy.accessionNo, due, by: asMember ? 'member' : 'counter' } });
    return { title: loan.copy.book.title, dueOn: due, renewals: loan.renewals + 1 };
};

// ─── Lost ────────────────────────────────────────────────────────────────────

/** A lent book is lost: the copy is marked lost and the member is charged (System Settings → Library). */
export const markLost = async (loanId: string, userId: string) => {
    const loan = await db.libraryLoan.findFirst({ where: { id: loanId, status: 'out' }, include: { copy: { include: { book: true } } } });
    if (!loan) throw notFound('This book isn’t lent out');
    const s = await getSettings({ how: LIBRARY.lostCharge, fixed: LIBRARY.lostFixed });
    const price = loan.copy.price ?? loan.copy.book.price ?? 0;
    const amount = s.how === 'fixed' ? s.fixed : s.how === 'price_plus' ? price + s.fixed : price || s.fixed;
    await db.libraryLoan.update({ where: { id: loanId }, data: { status: 'lost', returnedOn: dayDate(todayIST()), returnedBy: userId } });
    await db.bookCopy.update({ where: { id: loan.copyId }, data: { status: 'lost' } });
    const late = await lateFine(isoOf(loan.dueOn), todayIST());
    await addFine({ ...loan, loanId }, 'lost', amount, `${loan.copy.book.title} (${loan.copy.accessionNo}) lost`, userId);
    if (late.amount) await addFine({ ...loan, loanId }, 'late', late.amount, `${loan.copy.book.title}: ${late.days} day${late.days === 1 ? '' : 's'} late before it was lost`, userId);
    await recordAudit({ action: 'book_lost', entity: 'book', entityId: loan.bookId, changes: { copy: loan.copy.accessionNo, charged: amount } });
    return { charged: amount, lateFine: late.amount };
};

// ─── Reservations ────────────────────────────────────────────────────────────

export const reserveSchema = z.strictObject({ bookId: z.uuid(), memberKind: z.enum(['student', 'staff']), memberId: z.uuid() });

export const reserve = async (input: z.infer<typeof reserveSchema>, userId: string, asMember: boolean) => {
    if (asMember && !(await myMembers(userId)).some((m) => m.id === input.memberId && m.kind === input.memberKind)) throw forbidden();
    const b = await db.book.findFirst({ where: { id: input.bookId, isActive: true } });
    if (!b) throw notFound('Book not found');
    if (b.kind === 'ebook') throw badRequest('An e-book can be read online; no need to reserve it');
    const { max } = await getSettings({ max: LIBRARY.maxReservations });
    const where = whereMember(input.memberKind, input.memberId);
    if (await db.libraryReservation.findFirst({ where: { ...where, bookId: b.id, status: { in: ['waiting', 'ready'] } } })) throw badRequest('Already reserved');
    if (await db.libraryLoan.findFirst({ where: { ...where, bookId: b.id, status: 'out' } })) throw badRequest('This member already has this book');
    if (asMember && max === 0) throw forbidden('Reservations are made at the library counter');
    if (max && (await db.libraryReservation.count({ where: { ...where, status: { in: ['waiting', 'ready'] } } })) >= max) throw badRequest(`At most ${max} reservations at a time`);
    const r = await db.libraryReservation.create({ data: { tenantId: getTenantId()!, bookId: b.id, ...where, createdBy: userId } });
    // A copy on the shelf: kept for them now.
    const free = await db.bookCopy.findFirst({ where: { bookId: b.id, status: 'available' }, orderBy: { accessionNo: 'asc' } });
    if (free) await passToNextReservation(free.id, b.id);
    const place = await db.libraryReservation.count({ where: { bookId: b.id, status: 'waiting', createdAt: { lte: r.createdAt } } });
    return { id: r.id, ready: !!free, place };
};

export const cancelReservation = async (id: string, userId: string, asMember: boolean) => {
    const r = await db.libraryReservation.findFirst({ where: { id, status: { in: ['waiting', 'ready'] } } });
    if (!r) throw notFound('Reservation not found');
    if (asMember && !(await myMembers(userId)).some((m) => m.id === (r.staffId ?? r.studentId))) throw forbidden();
    await db.libraryReservation.update({ where: { id }, data: { status: 'cancelled' } });
    if (r.status === 'ready' && r.copyId) {
        await db.bookCopy.update({ where: { id: r.copyId }, data: { status: 'available' } });
        await passToNextReservation(r.copyId, r.bookId);
    }
    return { cancelled: true };
};

/** Daily: holds past their days go to the next member (or back on the shelf). */
export const expireHolds = async () => {
    const old = await db.libraryReservation.findMany({ where: { status: 'ready', holdUntil: { lt: dayDate(todayIST()) } } });
    for (const r of old) {
        await db.libraryReservation.update({ where: { id: r.id }, data: { status: 'expired' } });
        if (r.copyId) {
            await db.bookCopy.update({ where: { id: r.copyId }, data: { status: 'available' } });
            await passToNextReservation(r.copyId, r.bookId);
        }
    }
    return old.length;
};

// ─── Fines ───────────────────────────────────────────────────────────────────

export const waiveSchema = z.strictObject({ amount: z.number().int().min(1).max(1_000_000), reason: z.string().trim().min(3, 'is required').max(300) });
export const waiveFine = async (id: string, input: z.infer<typeof waiveSchema>, userId: string) => {
    const f = await db.libraryFine.findFirst({ where: { id } });
    if (!f) throw notFound('Fine not found');
    if (f.status === 'paid') throw badRequest('This fine is paid already');
    const left = f.amount - f.waived;
    if (input.amount > left) throw badRequest(`At most ${rupees(left)} can be waived`, [{ field: 'amount', message: `at most ${left}` }]);
    const waived = f.waived + input.amount;
    await db.libraryFine.update({ where: { id }, data: { waived, waiveReason: input.reason, waivedBy: userId, status: waived >= f.amount ? 'waived' : f.status } });
    await recordAudit({ action: 'library_fine_waived', entity: 'library_fine', entityId: id, changes: { amount: input.amount, reason: input.reason } });
    return { waived };
};

/** A counter fine paid at the library (its own receipt number). */
export const collectFine = async (id: string, userId: string) => {
    const f = await db.libraryFine.findFirst({ where: { id } });
    if (!f) throw notFound('Fine not found');
    if (f.payAt !== 'counter') throw badRequest('This fine is in the school fees; it is paid at the fee counter or online');
    if (f.status !== 'due') throw badRequest('Nothing to collect on this fine');
    const n = await takeNumbers('library_receipt', 1);
    const receiptNo = `LF/${todayIST().slice(0, 4)}/${String(n).padStart(4, '0')}`;
    await db.libraryFine.update({ where: { id }, data: { status: 'paid', paidOn: dayDate(todayIST()), receivedBy: userId, receiptNo } });
    await recordAudit({ action: 'library_fine_paid', entity: 'library_fine', entityId: id, changes: { amount: f.amount - f.waived, receiptNo } });
    return { receiptNo, amount: f.amount - f.waived };
};

export { unpaidFines };

// Students' fines in their fees: each fine goes into the first instalment due on or after its day (else the last).
registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const fines = await db.libraryFine.findMany({ where: { academicYearId: yearId, payAt: 'fees', studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, amount: true, waived: true, on: true } });
    const live = fines.filter((f) => f.amount - f.waived > 0);
    if (!live.length) return out;
    const { code } = await getSettings({ code: LIBRARY.feeHeadCode });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const sorted = [...instalments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const f of live) {
        const inst = sorted.find((i) => i.dueDate >= f.on) ?? sorted[sorted.length - 1];
        const lines = out.get(f.studentId!) ?? [];
        const same = lines.find((l) => l.instalmentId === inst.id);
        if (same) same.amount += f.amount - f.waived;
        else lines.push({ feeHeadId: head.id, instalmentId: inst.id, amount: f.amount - f.waived });
        out.set(f.studentId!, lines);
    }
    return out;
});
