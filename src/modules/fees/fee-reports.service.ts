import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { currentYear } from '../academic/years.service';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { computeDues, dueStudents } from './dues.service';
import type { collectionQuerySchema, duesQuerySchema } from './fees.schemas';
import type { Viewer } from './receipts.service';

/** Fee reports: dues (defaulters), the class summary, and money collected (day book). */

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

const yearOrCurrent = async (id?: string) => {
    if (id) return id;
    const y = await currentYear();
    if (!y) throw badRequest('No current academic year is set (Academic setup)');
    return y.id;
};

/** Students with what they owe (all of them, or only overdue amounts), class by class. */
export const duesReport = async (q: z.infer<typeof duesQuerySchema>, viewer: Viewer) => {
    const yearId = await yearOrCurrent(q.year);
    const scope = await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false });
    const search = q.search?.trim();
    const where = {
        AND: [
            scope,
            ...(search ? [{ OR: [{ firstName: { contains: search, mode: 'insensitive' as const } }, { lastName: { contains: search, mode: 'insensitive' as const } }, { admissionNo: { contains: search, mode: 'insensitive' as const } }] }] : []),
        ],
    };
    let students = await dueStudents(yearId, where);
    if (q.class) students = students.filter((s) => s.classId === q.class);
    if (q.section) students = students.filter((s) => s.sectionId === q.section);
    const dues = await computeDues(yearId, students, { asOf: q.asOf });
    const info = await db.student.findMany({
        where: { id: { in: students.map((s) => s.id) } },
        select: {
            id: true,
            admissionNo: true,
            firstName: true,
            middleName: true,
            lastName: true,
            status: true,
            family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, mobile: true } } } },
            enrolments: { where: { academicYearId: yearId }, select: { rollNumber: true, section: { select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } } } },
        },
    });
    const rows = info
        .map((s) => {
            const d = dues.get(s.id)!;
            const e = s.enrolments[0];
            const overdueInst = d.instalments.filter((i) => i.overdue);
            return {
                id: s.id,
                name: fullName(s),
                admissionNo: s.admissionNo,
                status: s.status,
                section: e ? `${e.section.schoolClass.shortName ?? e.section.schoolClass.name}-${e.section.name}` : '—',
                roll: e?.rollNumber ?? null,
                order: e ? e.section.schoolClass.sortOrder * 1000 + e.section.sortOrder : 0,
                parent: s.family?.guardians[0] ?? null,
                net: d.totals.net,
                paid: d.totals.paid,
                balance: d.totals.balance,
                overdue: d.totals.overdue,
                fine: d.totals.fine,
                overdueSince: overdueInst[0]?.dueDate ?? null,
                overdueInstalments: overdueInst.map((i) => i.name),
            };
        })
        .filter((r) => (q.show === 'everyone' ? true : q.show === 'all' ? r.balance > 0 : r.overdue > 0))
        .sort((a, b) => a.order - b.order || (a.roll ?? 999) - (b.roll ?? 999) || a.name.localeCompare(b.name));
    return {
        academicYearId: yearId,
        asOf: q.asOf ?? new Date().toISOString().slice(0, 10),
        students: rows.map(({ order: _o, ...r }) => r),
        totals: {
            students: rows.length,
            net: rows.reduce((a, r) => a + r.net, 0),
            paid: rows.reduce((a, r) => a + r.paid, 0),
            balance: rows.reduce((a, r) => a + r.balance, 0),
            overdue: rows.reduce((a, r) => a + r.overdue, 0),
        },
    };
};

/** Per class: what is to be collected this year, collected, due so far and overdue. */
export const classSummary = async (yearId: string | undefined, viewer: Viewer) => {
    const year = await yearOrCurrent(yearId);
    const scope = await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false });
    const students = await dueStudents(year, scope);
    const dues = await computeDues(year, students);
    const classes = await db.schoolClass.findMany({ where: { id: { in: [...new Set(students.map((s) => s.classId))] } }, select: { id: true, name: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } });
    const rows = classes.map((c) => {
        const mine = students.filter((s) => s.classId === c.id).map((s) => dues.get(s.id)!);
        const sum = (f: (d: (typeof mine)[number]) => number) => mine.reduce((a, d) => a + f(d), 0);
        return {
            id: c.id,
            name: c.name,
            students: mine.length,
            net: sum((d) => d.totals.net),
            paid: sum((d) => d.totals.paid),
            balance: sum((d) => d.totals.balance),
            overdue: sum((d) => d.totals.overdue),
            defaulters: mine.filter((d) => d.totals.overdue > 0).length,
        };
    });
    const total = (k: 'students' | 'net' | 'paid' | 'balance' | 'overdue' | 'defaulters') => rows.reduce((a, r) => a + r[k], 0);
    return { academicYearId: year, classes: rows, totals: { students: total('students'), net: total('net'), paid: total('paid'), balance: total('balance'), overdue: total('overdue'), defaulters: total('defaulters') } };
};

/** Money received in a period: by day, mode, fee head, class and collector; cancelled receipts; registration fees. */
export const collectionReport = async (q: z.infer<typeof collectionQuerySchema>, viewer: Viewer) => {
    if (q.from > q.to) throw badRequest('“From” is after “to”');
    const scope = await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false });
    const where = { date: { gte: toDate(q.from), lte: toDate(q.to) }, student: scope };
    const [receipts, cancelled, lines, registrations] = await Promise.all([
        db.feeReceipt.findMany({ where: { ...where, status: 'active' }, select: { id: true, date: true, mode: true, amount: true, createdBy: true, onlinePaymentId: true, studentId: true, academicYearId: true } }),
        db.feeReceipt.aggregate({ where: { ...where, status: 'cancelled' }, _sum: { amount: true }, _count: { _all: true } }),
        db.feeReceiptLine.findMany({ where: { receipt: { ...where, status: 'active' } }, select: { amount: true, isFine: true, feeHead: { select: { id: true, name: true, sortOrder: true } } } }),
        viewer.scope === 'all'
            ? db.enquiry.findMany({ where: { registrationFee: { gt: 0 }, registrationDate: { gte: toDate(q.from), lte: toDate(q.to) } }, select: { registrationFee: true, registrationFeeMode: true } })
            : Promise.resolve([]),
    ]);
    const group = <K extends string>(key: (r: (typeof receipts)[number]) => K) => {
        const m = new Map<K, { count: number; amount: number }>();
        for (const r of receipts) {
            const g = m.get(key(r)) ?? { count: 0, amount: 0 };
            g.count++;
            g.amount += r.amount;
            m.set(key(r), g);
        }
        return m;
    };
    const byDay = group((r) => r.date.toISOString().slice(0, 10));
    const byMode = group((r) => r.mode);
    const byCollector = group((r) => (r.onlinePaymentId ? 'online' : r.createdBy ?? 'unknown'));
    const users = new Map((await db.user.findMany({ where: { id: { in: [...byCollector.keys()].filter((k) => k !== 'online' && k !== 'unknown') } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const heads = new Map<string, { name: string; order: number; amount: number }>();
    for (const l of lines) {
        const key = l.isFine ? 'fine' : l.feeHead!.id;
        const h = heads.get(key) ?? { name: l.isFine ? 'Late fine' : l.feeHead!.name, order: l.isFine ? 1e9 : l.feeHead!.sortOrder, amount: 0 };
        h.amount += l.amount;
        heads.set(key, h);
    }
    const enrol = receipts.length
        ? await db.enrolment.findMany({ where: { studentId: { in: [...new Set(receipts.map((r) => r.studentId))] }, academicYearId: { in: [...new Set(receipts.map((r) => r.academicYearId))] } }, select: { studentId: true, academicYearId: true, section: { select: { schoolClass: { select: { id: true, name: true, sortOrder: true } } } } } })
        : [];
    const classOf = new Map(enrol.map((e) => [`${e.studentId}|${e.academicYearId}`, e.section.schoolClass]));
    const byClass = new Map<string, { name: string; order: number; count: number; amount: number }>();
    for (const r of receipts) {
        const c = classOf.get(`${r.studentId}|${r.academicYearId}`);
        const key = c?.id ?? 'none';
        const g = byClass.get(key) ?? { name: c?.name ?? '—', order: c?.sortOrder ?? 1e9, count: 0, amount: 0 };
        g.count++;
        g.amount += r.amount;
        byClass.set(key, g);
    }
    const regByMode = new Map<string, number>();
    for (const r of registrations) regByMode.set(r.registrationFeeMode ?? 'cash', (regByMode.get(r.registrationFeeMode ?? 'cash') ?? 0) + (r.registrationFee ?? 0));
    return {
        from: q.from,
        to: q.to,
        total: { count: receipts.length, amount: receipts.reduce((a, r) => a + r.amount, 0) },
        cancelled: { count: cancelled._count._all, amount: cancelled._sum.amount ?? 0 },
        byDay: [...byDay.entries()].map(([date, g]) => ({ date, ...g })).sort((a, b) => a.date.localeCompare(b.date)),
        byMode: [...byMode.entries()].map(([mode, g]) => ({ mode, ...g })).sort((a, b) => b.amount - a.amount),
        byHead: [...heads.entries()].map(([id, h]) => ({ id, name: h.name, amount: h.amount, order: h.order })).sort((a, b) => a.order - b.order).map(({ order: _o, ...h }) => h),
        byClass: [...byClass.entries()].map(([id, g]) => ({ id, ...g })).sort((a, b) => a.order - b.order).map(({ order: _o, ...g }) => g),
        byCollector: [...byCollector.entries()].map(([id, g]) => ({ id, name: id === 'online' ? 'Online payments' : users.get(id) ?? '—', ...g })).sort((a, b) => b.amount - a.amount),
        registrationFees: {
            count: registrations.length,
            amount: registrations.reduce((a, r) => a + (r.registrationFee ?? 0), 0),
            byMode: [...regByMode.entries()].map(([mode, amount]) => ({ mode, amount })),
        },
    };
};
