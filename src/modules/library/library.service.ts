import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { LIBRARY } from './library.settings';
import { findCopy } from './books.service';
import { lateFine } from './circulation.service';
import { memberCard, memberNames, myMembers } from './members.service';

/** Lists for the library screens (books out, fines, reservations), My Library and stock checks. */

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paging = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(200).default(25) };

/** Today at the counter. */
export const counterSummary = async () => {
    const today = dayDate(todayIST());
    const [out, overdue, dueToday, issuedToday, returnedToday, ready, books, copies] = await Promise.all([
        db.libraryLoan.count({ where: { status: 'out' } }),
        db.libraryLoan.count({ where: { status: 'out', dueOn: { lt: today } } }),
        db.libraryLoan.count({ where: { status: 'out', dueOn: today } }),
        db.libraryLoan.count({ where: { issuedOn: today } }),
        db.libraryLoan.count({ where: { returnedOn: today, status: 'returned' } }),
        db.libraryReservation.count({ where: { status: 'ready' } }),
        db.book.count({ where: { isActive: true } }),
        db.bookCopy.count({ where: { status: { notIn: ['withdrawn', 'lost'] } } }),
    ]);
    return { out, overdue, dueToday, issuedToday, returnedToday, ready, books, copies };
};

export const loansQuery = z.object({ show: z.enum(['out', 'overdue', 'due_today', 'returned', 'lost', 'all']).default('out'), search: z.string().trim().max(60).optional(), from: ISO.optional(), to: ISO.optional(), ...paging });

export const listLoans = async (q: z.infer<typeof loansQuery>) => {
    const today = dayDate(todayIST());
    const search = q.search
        ? await (async () => {
              const [s, t] = await Promise.all([
                  db.student.findMany({ where: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { admissionNo: { contains: q.search, mode: 'insensitive' } }] }, select: { id: true }, take: 200 }),
                  db.staff.findMany({ where: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { employeeCode: { contains: q.search, mode: 'insensitive' } }] }, select: { id: true }, take: 100 }),
              ]);
              return { OR: [{ studentId: { in: s.map((x) => x.id) } }, { staffId: { in: t.map((x) => x.id) } }, { copy: { accessionNo: { contains: q.search, mode: 'insensitive' as const } } }, { copy: { book: { title: { contains: q.search, mode: 'insensitive' as const } } } }] };
          })()
        : {};
    const where: Prisma.LibraryLoanWhereInput = {
        ...search,
        ...(q.show === 'out' ? { status: 'out' } : q.show === 'overdue' ? { status: 'out', dueOn: { lt: today } } : q.show === 'due_today' ? { status: 'out', dueOn: today } : q.show === 'returned' ? { status: 'returned' } : q.show === 'lost' ? { status: 'lost' } : {}),
        ...(q.from || q.to ? { issuedOn: { ...(q.from ? { gte: dayDate(q.from) } : {}), ...(q.to ? { lte: dayDate(q.to) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([db.libraryLoan.count({ where }), db.libraryLoan.findMany({ where, orderBy: q.show === 'returned' ? { returnedOn: 'desc' } : { dueOn: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { copy: { select: { accessionNo: true, book: { select: { id: true, title: true } } } } } })]);
    const names = await memberNames(rows);
    const todayIso = todayIST();
    const out = [];
    for (const l of rows) {
        const overdue = l.status === 'out' && isoOf(l.dueOn) < todayIso;
        out.push({ id: l.id, bookId: l.copy.book.id, title: l.copy.book.title, accessionNo: l.copy.accessionNo, memberKind: l.memberKind, member: names.get(l.studentId ?? l.staffId ?? '') ?? '', issuedOn: isoOf(l.issuedOn), dueOn: isoOf(l.dueOn), returnedOn: l.returnedOn ? isoOf(l.returnedOn) : null, status: l.status, renewals: l.renewals, overdue, fineSoFar: overdue ? (await lateFine(isoOf(l.dueOn), todayIso)).amount : 0 });
    }
    return { total, page: q.page, pageSize: q.pageSize, rows: out };
};

export const finesQuery = z.object({ show: z.enum(['due', 'paid', 'waived', 'all']).default('due'), payAt: z.enum(['fees', 'counter']).optional(), search: z.string().trim().max(60).optional(), ...paging });

export const listFines = async (q: z.infer<typeof finesQuery>) => {
    const search = q.search ? (await db.student.findMany({ where: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { admissionNo: { contains: q.search, mode: 'insensitive' } }] }, select: { id: true }, take: 200 })).map((s) => s.id) : null;
    const where: Prisma.LibraryFineWhereInput = {
        ...(q.show === 'due' ? { status: 'due' } : q.show === 'paid' ? { status: 'paid' } : q.show === 'waived' ? { waived: { gt: 0 } } : {}),
        ...(q.payAt ? { payAt: q.payAt } : {}),
        ...(search ? { studentId: { in: search } } : {}),
    };
    const [total, rows, sums] = await Promise.all([db.libraryFine.count({ where }), db.libraryFine.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }), db.libraryFine.aggregate({ where, _sum: { amount: true, waived: true } })]);
    const names = await memberNames(rows);
    return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        sum: { amount: sums._sum.amount ?? 0, waived: sums._sum.waived ?? 0 },
        rows: rows.map((f) => ({ id: f.id, member: names.get(f.studentId ?? f.staffId ?? '') ?? '', memberKind: f.memberKind, kind: f.kind, amount: f.amount, waived: f.waived, waiveReason: f.waiveReason, net: f.amount - f.waived, payAt: f.payAt, status: f.status, on: isoOf(f.on), note: f.note, receiptNo: f.receiptNo, paidOn: f.paidOn ? isoOf(f.paidOn) : null })),
    };
};

export const reservationsQuery = z.object({ show: z.enum(['waiting', 'ready', 'all']).default('ready'), ...paging });
export const listReservations = async (q: z.infer<typeof reservationsQuery>) => {
    const where: Prisma.LibraryReservationWhereInput = q.show === 'all' ? {} : { status: q.show };
    const [total, rows] = await Promise.all([db.libraryReservation.count({ where }), db.libraryReservation.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const [names, books, copies] = await Promise.all([memberNames(rows), db.book.findMany({ where: { id: { in: rows.map((r) => r.bookId) } }, select: { id: true, title: true } }), db.bookCopy.findMany({ where: { id: { in: rows.map((r) => r.copyId!).filter(Boolean) } }, select: { id: true, accessionNo: true } })]);
    return { total, page: q.page, pageSize: q.pageSize, rows: rows.map((r) => ({ id: r.id, bookId: r.bookId, title: books.find((b) => b.id === r.bookId)?.title ?? '', member: names.get(r.studentId ?? r.staffId ?? '') ?? '', status: r.status, accessionNo: copies.find((c) => c.id === r.copyId)?.accessionNo ?? null, holdUntil: r.holdUntil ? isoOf(r.holdUntil) : null, createdAt: r.createdAt })) };
};

// ─── My Library ──────────────────────────────────────────────────────────────

/** A member's own page (a parent sees each child): books they have, history, reservations, fines. */
export const myLibrary = async (userId: string) => {
    const members = await myMembers(userId);
    const s = await getSettings({ renew: LIBRARY.renewOnline, max: LIBRARY.maxReservations });
    const today = todayIST();
    const out = [];
    for (const m of members) {
        const card = await memberCard(m.kind, m.id);
        const where = m.kind === 'staff' ? { staffId: m.id } : { studentId: m.id };
        const [history, fines] = await Promise.all([
            db.libraryLoan.findMany({ where: { ...where, status: { not: 'out' } }, orderBy: { issuedOn: 'desc' }, take: 30, include: { copy: { select: { book: { select: { title: true, authors: true } } } } } }),
            db.libraryFine.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 }),
        ]);
        const loans = [];
        for (const l of card.loans) loans.push({ ...l, fineSoFar: l.overdue ? (await lateFine(l.dueOn, today)).amount : 0, canRenew: s.renew && !l.overdue && l.renewals < card.limits.renewals });
        out.push({
            member: { kind: m.kind, id: m.id, name: card.name, detail: card.detail, code: card.code },
            limits: card.limits,
            loans,
            reservations: card.reservations,
            history: history.map((h) => ({ id: h.id, title: h.copy.book.title, authors: h.copy.book.authors, issuedOn: isoOf(h.issuedOn), returnedOn: h.returnedOn ? isoOf(h.returnedOn) : null, status: h.status })),
            fines: fines.map((f) => ({ id: f.id, kind: f.kind, amount: f.amount, waived: f.waived, net: f.amount - f.waived, payAt: f.payAt, status: f.status, on: isoOf(f.on), note: f.note })),
            unpaid: card.fines,
        });
    }
    return { canReserve: s.max > 0, members: out };
};

// ─── Stock check ─────────────────────────────────────────────────────────────

export const listStockChecks = async () => {
    const rows = await db.libraryStockCheck.findMany({ orderBy: { startedAt: 'desc' }, take: 20, include: { _count: { select: { scans: true } } } });
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, startedAt: r.startedAt, closedAt: r.closedAt, scanned: r._count.scans }));
};

export const startStockCheck = async (name: string, userId: string) => {
    if (await db.libraryStockCheck.findFirst({ where: { status: 'open' } })) throw badRequest('A stock check is open already; close it first');
    const c = await db.libraryStockCheck.create({ data: { tenantId: getTenantId()!, name: name || `Stock check ${todayIST()}`, createdBy: userId } });
    return stockCheck(c.id);
};

/** A stock check: copies that should be on the shelf (not lent, lost or withdrawn) and which were scanned. */
export const stockCheck = async (id: string) => {
    const c = await db.libraryStockCheck.findFirst({ where: { id } });
    if (!c) throw notFound('Stock check not found');
    const [scans, shelf] = await Promise.all([db.libraryStockScan.findMany({ where: { checkId: id }, select: { copyId: true, at: true } }), db.bookCopy.findMany({ where: { status: { in: ['available', 'on_hold', 'damaged'] } }, select: { id: true, accessionNo: true, book: { select: { title: true, locationId: true } }, locationId: true } })]);
    const scanned = new Set(scans.map((s) => s.copyId));
    const locations = new Map((await db.masterValue.findMany({ where: { master: 'library_location' }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
    const missing = shelf.filter((x) => !scanned.has(x.id));
    return {
        id: c.id,
        name: c.name,
        status: c.status,
        startedAt: c.startedAt,
        closedAt: c.closedAt,
        expected: shelf.length,
        scanned: scans.length,
        missing: missing.sort((a, b) => a.accessionNo.localeCompare(b.accessionNo)).slice(0, 1000).map((x) => ({ id: x.id, accessionNo: x.accessionNo, title: x.book.title, location: locations.get(x.locationId ?? x.book.locationId ?? '') ?? null })),
        missingCount: missing.length,
    };
};

export const scanStock = async (id: string, accessionNo: string) => {
    const c = await db.libraryStockCheck.findFirst({ where: { id } });
    if (!c || c.status !== 'open') throw badRequest('This stock check is closed');
    const copy = await findCopy(accessionNo);
    const note = copy.status === 'issued' ? 'is lent out (should not be on the shelf)' : copy.status === 'lost' ? 'was marked lost: found!' : copy.status === 'withdrawn' ? 'is withdrawn' : null;
    await db.libraryStockScan.createMany({ data: [{ tenantId: getTenantId()!, checkId: id, copyId: copy.id }], skipDuplicates: true });
    return { accessionNo: copy.accessionNo, title: copy.book.title, note };
};

/** Closes a stock check; copies not found can be marked lost at once. */
export const closeStockCheck = async (id: string, markLost: boolean, userId: string) => {
    const r = await stockCheck(id);
    if (r.status !== 'open') throw badRequest('Already closed');
    if (markLost && r.missing.length) await db.bookCopy.updateMany({ where: { id: { in: r.missing.map((m) => m.id) } }, data: { status: 'lost', notes: `Not found in ${r.name}` } });
    await db.libraryStockCheck.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });
    await recordAudit({ action: 'stock_check_closed', entity: 'library', entityId: id, changes: { scanned: r.scanned, missing: r.missingCount, markedLost: markLost } });
    void userId;
    return stockCheck(id);
};
