import { randomUUID } from 'crypto';
import { Prisma, type PaymentMode } from '@prisma/client';
import { db, tenantSql } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { formatNumber, takeNumbers } from '../../core/numbering';
import { FEES } from './fees.settings';
import { computeDues, dueStudents, fineRule, lateFine } from './dues.service';
import { feeHeads } from './fee-setup.service';

/**
 * Demo fees for the current year, KV style: quarterly instalments; VVN for all, computer fund from
 * Class III, tuition for IX–XII, an admission fee for new students, exam fee in Quarter 3 for IX+;
 * girls and SC/ST exempt from tuition; staff wards and second children with a VVN concession; and
 * receipts for what has fallen due: most pay on time, some late with the fine, some part, some not.
 */

type Rand = { pick: <T>(l: readonly T[]) => T; between: (lo: number, hi: number) => number; chance: (p: number) => boolean };

const DAY = 86_400_000;
const MODES: [PaymentMode, number][] = [['cash', 45], ['upi', 30], ['cheque', 10], ['bank_transfer', 10], ['dd', 5]];
const BANKS = ['State Bank of India', 'Punjab National Bank', 'Bank of Baroda', 'Uttarakhand Gramin Bank', 'HDFC Bank'];

export const createDemoFees = async (year: { id: string; startDate: Date; endDate: Date }, rand: Rand) => {
    const tenantId = getTenantId()!;
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const heads = await feeHeads(false);
    const head = (code: string) => heads.find((h) => h.code === code)?.id ?? null;
    const [vvn, cf, tui, adm, exm] = ['VVN', 'CF', 'TUI', 'ADM', 'EXM'].map(head);
    if (!vvn) return { instalments: 0, receipts: 0, concessions: 0, parentLogins: 0 };

    // Quarterly instalments, due on the 15th of April, July, October and January.
    let instalments = await db.feeInstalment.findMany({ where: { academicYearId: year.id }, orderBy: { dueDate: 'asc' } });
    if (!instalments.length) {
        const y = year.startDate.getUTCFullYear();
        const quarters: [string, Date][] = [
            ['Quarter 1 (Apr–Jun)', new Date(Date.UTC(y, 3, 15))],
            ['Quarter 2 (Jul–Sep)', new Date(Date.UTC(y, 6, 15))],
            ['Quarter 3 (Oct–Dec)', new Date(Date.UTC(y, 9, 15))],
            ['Quarter 4 (Jan–Mar)', new Date(Date.UTC(y + 1, 0, 15))],
        ];
        await db.feeInstalment.createMany({ data: quarters.map(([name, dueDate], i) => ({ tenantId, academicYearId: year.id, name, dueDate, sortOrder: i + 1 })) });
        instalments = await db.feeInstalment.findMany({ where: { academicYearId: year.id }, orderBy: { dueDate: 'asc' } });
    }

    // Amounts per class (by position: 0–2 Bal Vatika, 3 = Class I … 14 = Class XII).
    const classes = await db.schoolClass.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (!(await db.feeStructureLine.count({ where: { academicYearId: year.id } }))) {
        const lines: { tenantId: string; academicYearId: string; classId: string; feeHeadId: string; instalmentId: string; amount: number }[] = [];
        classes.forEach((c, idx) => {
            const add = (h: string | null, amount: number, which: number[] = [0, 1, 2, 3]) => {
                if (h) for (const w of which) if (instalments[w]) lines.push({ tenantId, academicYearId: year.id, classId: c.id, feeHeadId: h, instalmentId: instalments[w].id, amount });
            };
            add(vvn, 1500);
            if (idx >= 5) add(cf, 300);
            if (idx >= 11) add(tui, idx >= 13 ? 900 : 600);
            add(adm, 25, [0]);
            if (idx >= 11) add(exm, 200, [2]);
        });
        await db.feeStructureLine.createMany({ data: lines });
    }

    // Concessions.
    const named = async (master: string, ...names: string[]) => (await db.masterValue.findMany({ where: { master, name: { in: names } }, select: { id: true } })).map((m) => m.id);
    let concessions = await db.feeConcession.findMany({ where: { academicYearId: year.id } });
    if (!concessions.length && tui) {
        const female = await named('gender', 'Female');
        const scst = await named('caste_category', 'SC', 'ST');
        const make = (name: string, automatic: boolean, lines: { feeHeadId: string; kind: 'percent' | 'amount'; value: number }[], cond: { genderIds?: string[]; casteCategoryIds?: string[] } = {}, note?: string) =>
            db.feeConcession.create({ data: { tenantId, academicYearId: year.id, name, automatic, ...cond, note: note ?? null, lines: { create: lines.map((l) => ({ ...l })) } } });
        await make('Girl students – no tuition fee', true, [{ feeHeadId: tui, kind: 'percent', value: 100 }], { genderIds: female }, 'As per KVS rules, girls are exempt from tuition fee.');
        if (scst.length) await make('SC / ST students – no tuition fee', true, [{ feeHeadId: tui, kind: 'percent', value: 100 }], { casteCategoryIds: scst });
        await make('KVS staff ward – no VVN', false, [{ feeHeadId: vvn, kind: 'percent', value: 100 }], {}, 'Wards of KVS employees.');
        await make('Second child – half VVN', false, [{ feeHeadId: vvn, kind: 'percent', value: 50 }], {}, 'The younger of two children studying here.');
        concessions = await db.feeConcession.findMany({ where: { academicYearId: year.id } });
    }
    const students = await dueStudents(year.id, { isDemo: true, status: 'active' });
    const manual = concessions.filter((c) => !c.automatic);
    const given: { tenantId: string; studentId: string; concessionId: string; note: string | null }[] = [];
    if (manual.length && !(await db.studentFeeConcession.count({ where: { concession: { academicYearId: year.id } } }))) {
        const staffWard = manual.find((c) => c.name.startsWith('KVS'));
        const sibling = manual.find((c) => c.name.startsWith('Second'));
        const pool = [...students];
        for (let i = 0; i < 8 && staffWard && pool.length; i++) given.push({ tenantId, studentId: pool.splice(rand.between(0, pool.length - 1), 1)[0].id, concessionId: staffWard.id, note: 'Parent is a KVS employee' });
        // Younger children of families with two here.
        if (sibling) {
            const fam = await db.student.findMany({ where: { id: { in: pool.map((p) => p.id) }, familyId: { not: null } }, select: { id: true, familyId: true, dateOfBirth: true } });
            const byFamily = new Map<string, typeof fam>();
            for (const f of fam) byFamily.set(f.familyId!, [...(byFamily.get(f.familyId!) ?? []), f]);
            for (const kids of byFamily.values()) {
                if (kids.length < 2 || given.length > 30) continue;
                const youngest = [...kids].sort((a, b) => (b.dateOfBirth?.getTime() ?? 0) - (a.dateOfBirth?.getTime() ?? 0))[0];
                given.push({ tenantId, studentId: youngest.id, concessionId: sibling.id, note: 'Sibling studying here' });
            }
        }
        if (given.length) await db.studentFeeConcession.createMany({ data: given, skipDuplicates: true });
    }

    // Receipts for what has fallen due by today, the way families really pay.
    const dues = await computeDues(year.id, students, { asOf: new Date(year.startDate.getTime() - DAY).toISOString().slice(0, 10) });
    const rule = await fineRule();
    const { pattern } = await getSettings({ pattern: FEES.receiptPattern });
    const collector = (await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: { in: ['accountant', 'office-staff'] } } } } }, select: { id: true } }))?.id ?? null;
    type Plan = { id: string; studentId: string; date: Date; mode: PaymentMode; reference: string | null; bankName: string | null; lines: { instalmentId: string; feeHeadId: string | null; isFine: boolean; amount: number }[] };
    const plans: Plan[] = [];
    for (const s of students) {
        const d = dues.get(s.id);
        if (!d) continue;
        // Each family has a habit: on time, late, or behind.
        const habit = rand.between(0, 99);
        for (const inst of d.instalments) {
            const due = new Date(`${inst.dueDate}T00:00:00.000Z`);
            if (due > new Date(today.getTime() + 20 * DAY)) continue;
            const r = rand.between(0, 99);
            if (habit >= 88 && r < 85) continue; // a defaulter
            if (habit >= 70 && due > new Date(today.getTime() - 30 * DAY) && r < 60) continue; // not yet paid the latest
            const lateBy = habit < 55 ? rand.between(-20, 5) : habit < 80 ? rand.between(0, 40) : rand.between(10, 75);
            let date = new Date(due.getTime() + lateBy * DAY);
            if (date > today) date = today;
            if (date < year.startDate) date = year.startDate;
            const part = habit >= 75 && r < 25;
            const lines: Plan['lines'] = [];
            for (const l of inst.lines) if (l.net > 0) lines.push({ instalmentId: inst.id, feeHeadId: l.feeHeadId, isFine: false, amount: part ? Math.round(l.net / 2) : l.net });
            if (!lines.length) continue;
            const fine = part ? 0 : lateFine(rule, due, date);
            if (fine > 0) lines.push({ instalmentId: inst.id, feeHeadId: null, isFine: true, amount: fine });
            const mode = (() => {
                let w = rand.between(1, 100);
                for (const [m, weight] of MODES) if ((w -= weight) <= 0) return m;
                return 'cash' as PaymentMode;
            })();
            plans.push({
                id: randomUUID(),
                studentId: s.id,
                date,
                mode,
                reference: mode === 'cash' ? null : mode === 'upi' ? `UPI${rand.between(100000000, 999999999)}` : mode === 'cheque' || mode === 'dd' ? String(rand.between(100000, 999999)) : `NEFT${rand.between(10000000, 99999999)}`,
                bankName: mode === 'cheque' || mode === 'dd' ? rand.pick(BANKS) : null,
                lines,
            });
        }
    }
    plans.sort((a, b) => a.date.getTime() - b.date.getTime());
    // Receipt numbers in date order, per calendar year when the pattern has the year.
    const yearly = /\{YY(YY)?\}/.test(pattern);
    const groups = new Map<string, Plan[]>();
    for (const p of plans) {
        const key = yearly ? `receipt:${p.date.getUTCFullYear()}` : 'receipt';
        groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const numbers = new Map<string, string>();
    for (const [key, list] of groups) {
        const first = await takeNumbers(key, 1, list.length);
        list.forEach((p, i) => numbers.set(p.id, formatNumber(pattern, { seq: first + i, date: p.date })));
    }
    for (let i = 0; i < plans.length; i += 500) {
        const chunk = plans.slice(i, i + 500);
        await db.feeReceipt.createMany({
            data: chunk.map((p) => ({
                id: p.id,
                tenantId,
                receiptNo: numbers.get(p.id)!,
                studentId: p.studentId,
                academicYearId: year.id,
                date: p.date,
                mode: p.mode,
                reference: p.reference,
                bankName: p.bankName,
                amount: p.lines.reduce((a, l) => a + l.amount, 0),
                isDemo: true,
                createdBy: collector,
                createdAt: new Date(p.date.getTime() + rand.between(9, 14) * 3_600_000),
            })),
        });
        await db.feeReceiptLine.createMany({ data: chunk.flatMap((p) => p.lines.map((l) => ({ tenantId, receiptId: p.id, ...l }))) });
    }
    // Two receipts entered wrongly and cancelled.
    for (const p of plans.slice(10, 12)) await db.feeReceipt.update({ where: { id: p.id }, data: { status: 'cancelled', cancelledAt: new Date(p.date.getTime() + 3_600_000), cancelReason: 'Wrong student selected; issued again' } });

    return { instalments: instalments.length, receipts: plans.length, concessions: given.length, parentLogins: 0 };
};

/** Logins for demo families' main contacts (username = mobile; the demo password). */
export const createDemoParentLogins = async (passwordHash: string) => {
    const tenantId = getTenantId()!;
    const role = await db.role.findFirst({ where: { defaultFor: 'guardian' }, select: { id: true } });
    const guardians = await db.guardian.findMany({ where: { isPrimary: true, userId: null, family: { isDemo: true }, mobile: { not: null } }, select: { id: true, name: true, mobile: true, email: true } });
    const taken = new Set((await db.user.findMany({ select: { username: true, mobile: true, email: true } })).flatMap((u) => [u.username, u.mobile, u.email].filter((x): x is string => !!x)));
    const rows = guardians.filter((g) => !taken.has(g.mobile!) && (!g.email || !taken.has(g.email))).map((g) => ({ g, id: randomUUID() }));
    for (const r of rows) taken.add(r.g.mobile!);
    if (!rows.length) return 0;
    await db.user.createMany({
        data: rows.map(({ g, id }) => ({ id, tenantId, kind: 'guardian' as const, username: g.mobile!, displayName: g.name, mobile: g.mobile, email: g.email, passwordHash, mustChangePassword: false, isDemo: true })),
    });
    if (role) await db.userRole.createMany({ data: rows.map(({ id }) => ({ tenantId, userId: id, roleId: role.id })) });
    // One statement links every parent to their login.
    await tenantSql((t) => Prisma.sql`
        UPDATE guardians AS g SET user_id = v.user_id::uuid
        FROM (VALUES ${Prisma.join(rows.map(({ g, id }) => Prisma.sql`(${g.id}, ${id})`))}) AS v(guardian_id, user_id)
        WHERE g.id = v.guardian_id::uuid AND g.tenant_id = ${t}::uuid`);
    return rows.length;
};

/** Removes the demo fees (receipts and online payments of demo students; the set-up stays). */
export const clearDemoFees = async () => {
    const receipts = await db.feeReceipt.deleteMany({ where: { OR: [{ isDemo: true }, { student: { isDemo: true } }] } });
    await db.onlinePayment.deleteMany({ where: { student: { isDemo: true } } });
    if (!(await db.feeReceipt.count())) await db.numberSequence.deleteMany({ where: { key: { startsWith: 'receipt' } } });
    return receipts.count;
};
