import { Prisma, type DataScope } from '@prisma/client';
import { counterMode } from './payment-modes';
import { z } from 'zod';
import { db, lockInTransaction, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { formatNumber, takeNumbers } from '../../core/numbering';
import { ListQuery, listResult } from '../../core/http/list-query';
import { currentYear } from '../academic/years.service';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { FEES } from './fees.settings';
import { allocate, AllocationLine, computeDues, coversWhole, dueStudents, StudentDues } from './dues.service';
import { dayOf } from './fee-setup.service';
import type { receiptFilters } from './fees.schemas';
import { alertReceipt } from './fee.alerts';

/** Taking fees (counter and online), receipts, cancelling, and a student's fee page. */

export interface Viewer {
    userId: string;
    /** fee.view: all, assigned (class / subject teacher's sections), own (a student or their parent). */
    scope: DataScope;
}

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = () => new Date().toISOString().slice(0, 10);
const uuidOk = (id: string) => z.uuid().safeParse(id).success;

/** The student, if the viewer may see their fees. */
const visibleStudent = async (id: string, viewer: Viewer, client: typeof db | Tx = db) => {
    const s = uuidOk(id) ? await client.student.findFirst({ where: { id, ...(await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false })) } }) : null;
    if (!s) throw notFound('Student not found');
    return s;
};

const resolveYear = async (yearId?: string) => {
    if (yearId) return yearId;
    const y = await currentYear();
    if (!y) throw badRequest('No current academic year is set (Academic setup)');
    return y.id;
};

/** One student's dues in a year (with their class from that year's enrolment). */
export const duesOf = async (studentId: string, yearId: string, client: typeof db | Tx = db, asOf?: string): Promise<StudentDues | null> => {
    const [s] = await dueStudents(yearId, { id: studentId }, client);
    if (!s) return null;
    return (await computeDues(yearId, [s], { client, asOf })).get(studentId)!;
};

// ─── Receipt numbers ─────────────────────────────────────────────────────────

const allocateReceiptNo = async (date: Date, client: typeof db | Tx) => {
    const { pattern } = await getSettings({ pattern: FEES.receiptPattern });
    const key = /\{YY(YY)?\}/.test(pattern) ? `receipt:${date.getUTCFullYear()}` : 'receipt';
    for (let attempt = 0; attempt < 20; attempt++) {
        const no = formatNumber(pattern, { seq: await takeNumbers(key, 1), date });
        if (!(await client.feeReceipt.findFirst({ where: { receiptNo: { equals: no, mode: 'insensitive' } }, select: { id: true } }))) return no;
    }
    throw conflict('Could not find a free receipt number; check the pattern in System Settings → Fees');
};

/** Only one payment of a student is worked out at a time (two cashiers, or the counter and online). */
const lockStudent = (tx: Tx, studentId: string) => lockInTransaction(tx, `fees:${studentId}`);

// ─── Taking a payment ────────────────────────────────────────────────────────

export const collectSchema = z.strictObject({
    studentId: z.uuid(),
    academicYearId: z.uuid().optional(),
    date: z.iso.date().optional(),
    /** A payment mode's code (Masters → Payment modes). */
    mode: z.string().trim().min(1, 'choose a payment mode').max(20),
    reference: z.union([z.literal('').transform(() => null), z.string().trim().max(60), z.null()]).optional(),
    bankName: z.union([z.literal('').transform(() => null), z.string().trim().max(80), z.null()]).optional(),
    amount: z.number().int('whole rupees').min(1, 'must be at least ₹1').max(10_000_000),
    /** Pay only these instalments (oldest first among them); empty = oldest dues first. */
    instalmentIds: z.array(z.uuid()).max(24).optional(),
    note: z.union([z.literal('').transform(() => null), z.string().trim().max(300), z.null()]).optional(),
});

interface ReceiptInput {
    studentId: string;
    yearId: string;
    date: string;
    mode: string;
    reference?: string | null;
    bankName?: string | null;
    amount: number;
    instalmentIds?: string[];
    note?: string | null;
    onlinePaymentId?: string;
    isDemo?: boolean;
}

/**
 * Records a receipt inside `tx` (the student is locked first). With `allowExcess`, money beyond
 * the dues (an online payment that crossed a counter payment) is reported instead of refused.
 */
export const recordReceipt = async (tx: Tx, input: ReceiptInput, opts: { allowExcess?: boolean } = {}) => {
    await lockStudent(tx, input.studentId);
    const dues = await duesOf(input.studentId, input.yearId, tx, input.date);
    if (!dues) throw badRequest('The student is not enrolled in that academic year');
    const s = await getSettings({ partial: FEES.partialPayment });
    const { lines, left } = allocate(dues, input.amount, input.instalmentIds?.length ? input.instalmentIds : undefined);
    if (left > 0 && !opts.allowExcess) {
        const due = input.amount - left;
        throw badRequest(due ? `Only ₹${due} is due${input.instalmentIds?.length ? ' for the chosen instalments' : ''}` : 'Nothing is due', [{ field: 'amount', message: `must be at most ₹${due}` }]);
    }
    // Online money that finds nothing due any more is recorded on the payment for a refund.
    if (!lines.length) {
        if (opts.allowExcess) return { receipt: null, excess: input.amount };
        throw badRequest('Nothing is due');
    }
    if (!s.partial && !opts.allowExcess && !coversWhole(dues, lines)) throw badRequest('Part payment is switched off: pay whole instalments (System Settings → Fees)', [{ field: 'amount', message: 'must cover whole instalments' }]);
    const paid = lines.reduce((a, l) => a + l.amount, 0);
    const date = toDate(input.date);
    const receiptNo = await allocateReceiptNo(date, tx);
    const tenantId = getTenantId()!;
    const receipt = await tx.feeReceipt.create({
        data: {
            tenantId,
            receiptNo,
            studentId: input.studentId,
            academicYearId: input.yearId,
            date,
            mode: input.mode,
            reference: input.reference ?? null,
            bankName: input.bankName ?? null,
            amount: paid,
            note: left > 0 ? [input.note, `₹${left} more was paid than was due: refund it or keep it as advance.`].filter(Boolean).join(' ') : input.note ?? null,
            onlinePaymentId: input.onlinePaymentId ?? null,
            isDemo: input.isDemo ?? false,
            lines: { create: lines.map((l) => ({ ...l })) },
        },
    });
    return { receipt, excess: left };
};

export const collectFee = async (input: z.infer<typeof collectSchema>, viewer: Viewer) => {
    await visibleStudent(input.studentId, viewer);
    const yearId = await resolveYear(input.academicYearId);
    const date = input.date ?? today();
    if (date > today()) throw badRequest('A receipt can’t be dated in the future', [{ field: 'date', message: 'is in the future' }]);
    const chosen = await counterMode(input.mode, input.reference);
    if (chosen.needsReference) throw badRequest(`Enter the ${chosen.mode.name} reference (cheque / DD / transaction number)`, [{ field: 'reference', message: 'is required for this mode' }]);
    input = { ...input, mode: chosen.mode.code };
    const { receipt: made } = await withTransaction((tx) => recordReceipt(tx, { ...input, yearId, date }), { timeout: 30_000 });
    const receipt = made!;
    await recordAudit({ action: 'fee_collected', entity: 'fee_receipt', entityId: receipt.id, changes: { receiptNo: receipt.receiptNo, amount: receipt.amount, mode: receipt.mode } });
    alertReceipt(receipt.id, viewer.userId);
    return getReceipt(receipt.id, { ...viewer, scope: 'all' });
};

// ─── Receipts ────────────────────────────────────────────────────────────────

const receiptInclude = {
    student: { select: { id: true, admissionNo: true, firstName: true, middleName: true, lastName: true, family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, mobile: true, relation: { select: { name: true } } } } } } } },
    academicYear: { select: { id: true, name: true } },
    lines: { include: { instalment: { select: { id: true, name: true, dueDate: true } }, feeHead: { select: { id: true, name: true, extra: true, sortOrder: true } } } },
    onlinePayment: { select: { id: true, provider: true, paymentRef: true, convenienceFee: true } },
} satisfies Prisma.FeeReceiptInclude;

type ReceiptRow = Prisma.FeeReceiptGetPayload<{ include: typeof receiptInclude }>;

const userNames = async (ids: (string | null)[]) => {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    return new Map((await db.user.findMany({ where: { id: { in: list } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
};

const sectionOf = async (studentIds: string[], yearIds: string[]) => {
    const rows = await db.enrolment.findMany({
        where: { studentId: { in: studentIds }, academicYearId: { in: yearIds } },
        select: { studentId: true, academicYearId: true, rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } },
    });
    return new Map(rows.map((r) => [`${r.studentId}|${r.academicYearId}`, { label: `${r.section.schoolClass.shortName ?? r.section.schoolClass.name}-${r.section.name}`, roll: r.rollNumber }]));
};

const presentReceipt = (r: ReceiptRow, names: Map<string, string>, sections: Map<string, { label: string; roll: number | null }>) => {
    const byInst = new Map<string, { id: string; name: string; dueDate: string; lines: { head: string; amount: number; refundable: boolean }[]; fine: number }>();
    const sorted = [...r.lines].sort((a, b) => a.instalment.dueDate.getTime() - b.instalment.dueDate.getTime() || (a.feeHead?.sortOrder ?? 9999) - (b.feeHead?.sortOrder ?? 9999));
    for (const l of sorted) {
        const g = byInst.get(l.instalmentId) ?? { id: l.instalmentId, name: l.instalment.name, dueDate: dayOf(l.instalment.dueDate)!, lines: [], fine: 0 };
        if (l.isFine) g.fine += l.amount;
        else g.lines.push({ head: l.feeHead?.name ?? '—', amount: l.amount, refundable: !!(l.feeHead?.extra as { refundable?: boolean } | undefined)?.refundable });
        byInst.set(l.instalmentId, g);
    }
    const guardian = r.student.family?.guardians[0];
    return {
        id: r.id,
        receiptNo: r.receiptNo,
        date: dayOf(r.date)!,
        student: { id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, section: sections.get(`${r.studentId}|${r.academicYearId}`)?.label ?? null, roll: sections.get(`${r.studentId}|${r.academicYearId}`)?.roll ?? null },
        parent: guardian ? { name: guardian.name, relation: guardian.relation?.name ?? null, mobile: guardian.mobile } : null,
        academicYear: r.academicYear,
        mode: r.mode,
        reference: r.reference,
        bankName: r.bankName,
        amount: r.amount,
        note: r.note,
        status: r.status,
        cancelledAt: r.cancelledAt,
        cancelledBy: r.cancelledBy ? names.get(r.cancelledBy) ?? null : null,
        cancelReason: r.cancelReason,
        collectedBy: r.createdBy ? names.get(r.createdBy) ?? null : r.onlinePayment ? 'Online' : null,
        online: r.onlinePayment ? { provider: r.onlinePayment.provider, paymentRef: r.onlinePayment.paymentRef, convenienceFee: r.onlinePayment.convenienceFee } : null,
        createdAt: r.createdAt,
        instalments: [...byInst.values()],
    };
};

export const getReceipt = async (id: string, viewer: Viewer) => {
    const r = uuidOk(id) ? await db.feeReceipt.findUnique({ where: { id }, include: receiptInclude }) : null;
    if (!r) throw notFound('Receipt not found');
    await visibleStudent(r.studentId, viewer);
    const [names, sections] = await Promise.all([userNames([r.createdBy, r.cancelledBy]), sectionOf([r.studentId], [r.academicYearId])]);
    const { note } = await getSettings({ note: FEES.receiptNote });
    return { ...presentReceipt(r, names, sections), footer: note };
};

export const listReceipts = async (q: ListQuery<typeof receiptFilters>, viewer: Viewer) => {
    const f = q.filters;
    const and: Prisma.FeeReceiptWhereInput[] = [{ student: await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false }) }];
    if (f.from) and.push({ date: { gte: toDate(f.from) } });
    if (f.to) and.push({ date: { lte: toDate(f.to) } });
    if (f.mode) and.push({ mode: f.mode });
    if (f.status) and.push({ status: f.status });
    if (f.year) and.push({ academicYearId: f.year });
    if (f.student) and.push({ studentId: f.student });
    if (f.collector) and.push({ createdBy: f.collector });
    if (f.class) and.push({ student: { enrolments: { some: { section: { classId: f.class }, ...(f.year ? { academicYearId: f.year } : {}) } } } });
    if (q.search) {
        and.push({
            OR: [
                { receiptNo: { contains: q.search, mode: 'insensitive' } },
                { reference: { contains: q.search, mode: 'insensitive' } },
                { student: { admissionNo: { contains: q.search, mode: 'insensitive' } } },
                { student: { firstName: { contains: q.search, mode: 'insensitive' } } },
                { student: { lastName: { contains: q.search, mode: 'insensitive' } } },
            ],
        });
    }
    const where = { AND: and };
    const orderBy: Prisma.FeeReceiptOrderByWithRelationInput[] = q.sort === 'amount' ? [{ amount: q.order }] : q.sort === 'receiptNo' ? [{ receiptNo: q.order }] : [{ date: q.order }, { createdAt: q.order }];
    const [rows, total, sum] = await Promise.all([
        db.feeReceipt.findMany({ where, include: receiptInclude, orderBy, skip: q.skip, take: q.take }),
        db.feeReceipt.count({ where }),
        db.feeReceipt.aggregate({ where: { AND: [...and, { status: 'active' }] }, _sum: { amount: true } }),
    ]);
    const [names, sections] = await Promise.all([userNames(rows.flatMap((r) => [r.createdBy, r.cancelledBy])), sectionOf(rows.map((r) => r.studentId), [...new Set(rows.map((r) => r.academicYearId))])]);
    return { ...listResult(rows.map((r) => presentReceipt(r, names, sections)), total, q), totalAmount: sum._sum.amount ?? 0 };
};

export const cancelSchema = z.strictObject({ reason: z.string().trim().min(3, 'write why').max(300) });

/** A receipt is never changed: it is cancelled (the dues come back) and a new one is made. */
export const cancelReceipt = async (id: string, input: z.infer<typeof cancelSchema>, viewer: Viewer) => {
    const r = uuidOk(id) ? await db.feeReceipt.findUnique({ where: { id } }) : null;
    if (!r) throw notFound('Receipt not found');
    if (r.status === 'cancelled') throw conflict('This receipt is already cancelled');
    if (r.onlinePaymentId) throw conflict('An online payment can’t be cancelled here: refund it from the gateway, then cancel it after the refund (ask the administrator)');
    await db.feeReceipt.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: viewer.userId, cancelReason: input.reason } });
    await recordAudit({ action: 'fee_receipt_cancelled', entity: 'fee_receipt', entityId: id, changes: { receiptNo: r.receiptNo, amount: r.amount, reason: input.reason } });
    return getReceipt(id, { ...viewer, scope: 'all' });
};

// ─── A student's fees ────────────────────────────────────────────────────────

export const studentFees = async (studentId: string, yearId: string | undefined, viewer: Viewer) => {
    const s = await visibleStudent(studentId, viewer);
    const year = await resolveYear(yearId);
    const [dues, receipts, given, adjustments, enrolment] = await Promise.all([
        duesOf(studentId, year),
        db.feeReceipt.findMany({ where: { studentId, academicYearId: year }, include: receiptInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
        db.studentFeeConcession.findMany({ where: { studentId, concession: { academicYearId: year } }, include: { concession: { select: { id: true, name: true } } } }),
        db.feeAdjustment.findMany({ where: { studentId, academicYearId: year }, include: { instalment: { select: { name: true } }, feeHead: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
        db.enrolment.findFirst({ where: { studentId, academicYearId: year }, select: { rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }),
    ]);
    const names = await userNames([...receipts.flatMap((r) => [r.createdBy, r.cancelledBy]), ...adjustments.map((a) => a.createdBy)]);
    const sections = await sectionOf([studentId], [year]);
    return {
        student: {
            id: s.id,
            name: fullName(s),
            admissionNo: s.admissionNo,
            status: s.status,
            section: enrolment ? `${enrolment.section.schoolClass.shortName ?? enrolment.section.schoolClass.name}-${enrolment.section.name}` : null,
            roll: enrolment?.rollNumber ?? null,
        },
        academicYearId: year,
        enrolled: !!dues,
        dues,
        receipts: receipts.map((r) => presentReceipt(r, names, sections)),
        concessions: given.map((g) => ({ id: g.id, concession: g.concession, note: g.note, createdAt: g.createdAt })),
        adjustments: adjustments.map((a) => ({
            id: a.id,
            instalment: a.instalment.name,
            head: a.isFine ? 'Late fine' : a.feeHead?.name ?? '—',
            amount: a.amount,
            reason: a.reason,
            by: a.createdBy ? names.get(a.createdBy) ?? null : null,
            createdAt: a.createdAt,
        })),
    };
};

export const giveConcessionSchema = z.strictObject({ concessionId: z.uuid(), note: z.union([z.literal('').transform(() => null), z.string().trim().max(300), z.null()]).optional() });

export const giveConcession = async (studentId: string, input: z.infer<typeof giveConcessionSchema>, viewer: Viewer) => {
    await visibleStudent(studentId, viewer);
    const c = await db.feeConcession.findUnique({ where: { id: input.concessionId } });
    if (!c) throw notFound('Concession not found');
    if (c.automatic) throw badRequest('This concession is automatic: it applies by itself to the students it is for');
    if (await db.studentFeeConcession.findFirst({ where: { studentId, concessionId: c.id } })) throw conflict('The student already has this concession');
    await db.studentFeeConcession.create({ data: { tenantId: getTenantId()!, studentId, concessionId: c.id, note: input.note ?? null } });
    await recordAudit({ action: 'fee_concession_given', entity: 'student', entityId: studentId, changes: { concession: c.name, note: input.note ?? null } });
    return studentFees(studentId, c.academicYearId, viewer);
};

export const removeConcession = async (studentId: string, id: string, viewer: Viewer) => {
    await visibleStudent(studentId, viewer);
    const g = uuidOk(id) ? await db.studentFeeConcession.findFirst({ where: { id, studentId }, include: { concession: true } }) : null;
    if (!g) throw notFound('Concession not found');
    await db.studentFeeConcession.delete({ where: { id } });
    await recordAudit({ action: 'fee_concession_removed', entity: 'student', entityId: studentId, changes: { concession: g.concession.name } });
    return studentFees(studentId, g.concession.academicYearId, viewer);
};

export const adjustmentSchema = z.strictObject({
    instalmentId: z.uuid(),
    /** A fee head, or "fine" for the instalment's late fine. */
    feeHeadId: z.union([z.uuid(), z.literal('fine')]),
    /** + = extra charge, − = waiver. */
    amount: z.number().int('whole rupees').min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'can’t be 0'),
    reason: z.string().trim().min(3, 'write why').max(300),
});

export const addAdjustment = async (studentId: string, input: z.infer<typeof adjustmentSchema>, viewer: Viewer) => {
    await visibleStudent(studentId, viewer);
    const inst = await db.feeInstalment.findUnique({ where: { id: input.instalmentId } });
    if (!inst) throw notFound('Instalment not found');
    const isFine = input.feeHeadId === 'fine';
    if (isFine && input.amount > 0) throw badRequest('The late fine is worked out by itself; it can only be waived (a minus amount)', [{ field: 'amount', message: 'must be a minus amount for the fine' }]);
    if (!isFine && (await db.masterValue.findUnique({ where: { id: input.feeHeadId } }))?.master !== 'fee_head') throw badRequest('Choose a fee head', [{ field: 'feeHeadId', message: 'is not a fee head' }]);
    await db.feeAdjustment.create({
        data: { tenantId: getTenantId()!, studentId, academicYearId: inst.academicYearId, instalmentId: inst.id, feeHeadId: isFine ? null : input.feeHeadId, isFine, amount: input.amount, reason: input.reason },
    });
    await recordAudit({ action: input.amount < 0 ? 'fee_waived' : 'fee_charged', entity: 'student', entityId: studentId, changes: { instalment: inst.name, head: isFine ? 'Late fine' : input.feeHeadId, amount: input.amount, reason: input.reason } });
    return studentFees(studentId, inst.academicYearId, viewer);
};

export const removeAdjustment = async (studentId: string, id: string, viewer: Viewer) => {
    await visibleStudent(studentId, viewer);
    const a = uuidOk(id) ? await db.feeAdjustment.findFirst({ where: { id, studentId } }) : null;
    if (!a) throw notFound('Change not found');
    await db.feeAdjustment.delete({ where: { id } });
    await recordAudit({ action: 'fee_adjustment_removed', entity: 'student', entityId: studentId, changes: { amount: a.amount, reason: a.reason } });
    return studentFees(studentId, a.academicYearId, viewer);
};

/** Students for the fee counter's search (name, admission no, parent's mobile). */
export const searchStudents = async (search: string, viewer: Viewer) => {
    const q = search.trim();
    if (q.length < 2) return [];
    const digits = q.replace(/\D/g, '');
    const year = await currentYear();
    const rows = await db.student.findMany({
        where: {
            AND: [
                await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false }),
                {
                    OR: [
                        { firstName: { contains: q, mode: 'insensitive' } },
                        { lastName: { contains: q, mode: 'insensitive' } },
                        { admissionNo: { contains: q, mode: 'insensitive' } },
                        ...(digits.length >= 4 ? [{ family: { guardians: { some: { mobile: { contains: digits } } } } }] : []),
                    ],
                },
            ],
        },
        select: {
            id: true,
            admissionNo: true,
            firstName: true,
            middleName: true,
            lastName: true,
            status: true,
            family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, mobile: true } } } },
            enrolments: { where: year ? { academicYearId: year.id } : {}, select: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } }, take: 1 },
        },
        take: 15,
        orderBy: [{ firstName: 'asc' }],
    });
    return rows.map((s) => ({
        id: s.id,
        name: fullName(s),
        admissionNo: s.admissionNo,
        status: s.status,
        section: s.enrolments[0] ? `${s.enrolments[0].section.schoolClass.shortName ?? s.enrolments[0].section.schoolClass.name}-${s.enrolments[0].section.name}` : null,
        parent: s.family?.guardians[0] ? { name: s.family.guardians[0].name, mobile: s.family.guardians[0].mobile } : null,
    }));
};

export type { AllocationLine };
