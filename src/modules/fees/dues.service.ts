import { db, Tx } from '../../core/db';
import { getSettings } from '../../core/settings';
import { FEES } from './fees.settings';
import { dayOf, feeHeads } from './fee-setup.service';

/**
 * What students owe: worked out from the structure of their class, their concessions, one-off
 * adjustments, the late fine and what they have paid. Nothing is stored ahead; a change to the
 * structure shows at once. Amounts are whole rupees.
 */

export interface DueStudent {
    id: string;
    classId: string;
    admissionDate: Date;
    status: string;
    statusDate: Date | null;
    genderId: string | null;
    casteCategoryId: string | null;
    categoryId: string | null;
}

export interface DueLine {
    feeHeadId: string;
    head: string;
    gross: number;
    concession: number;
    adjustment: number;
    net: number;
    paid: number;
    balance: number;
}

export interface DueInstalment {
    id: string;
    name: string;
    dueDate: string;
    lines: DueLine[];
    fine: { charged: number; waived: number; paid: number; balance: number };
    net: number;
    paid: number;
    /** Still to pay, fine included. */
    balance: number;
    /** Past its due date with something left to pay. */
    overdue: boolean;
}

export interface StudentDues {
    studentId: string;
    instalments: DueInstalment[];
    concessions: { id: string; name: string; automatic: boolean }[];
    totals: { net: number; paid: number; fine: number; balance: number; overdue: number };
}

export interface FineRule {
    mode: 'none' | 'fixed' | 'per_day' | 'per_month';
    amount: number;
    graceDays: number;
    cap: number;
}

const DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** The late fine for an instalment due on `due`, on the day `asOf`. */
export const lateFine = (rule: FineRule, due: Date, asOf: Date) => {
    const late = Math.floor((asOf.getTime() - due.getTime()) / DAY) - rule.graceDays;
    if (rule.mode === 'none' || late <= 0 || rule.amount <= 0) return 0;
    const fine = rule.mode === 'fixed' ? rule.amount : rule.mode === 'per_day' ? late * rule.amount : Math.ceil(late / 30) * rule.amount;
    return rule.cap > 0 ? Math.min(fine, rule.cap) : fine;
};

export const fineRule = async (): Promise<FineRule> => {
    const s = await getSettings({ mode: FEES.fineMode, amount: FEES.fineAmount, graceDays: FEES.fineGraceDays, cap: FEES.fineCap });
    return s;
};

const matches = (c: { genderIds: string[]; casteCategoryIds: string[]; categoryIds: string[]; classIds: string[] }, s: DueStudent) =>
    (!c.genderIds.length || (!!s.genderId && c.genderIds.includes(s.genderId))) &&
    (!c.casteCategoryIds.length || (!!s.casteCategoryId && c.casteCategoryIds.includes(s.casteCategoryId))) &&
    (!c.categoryIds.length || (!!s.categoryId && c.categoryIds.includes(s.categoryId))) &&
    (!c.classIds.length || c.classIds.includes(s.classId));

/** Dues of many students of one year, as on `asOf` (YYYY-MM-DD; default today). */
export const computeDues = async (yearId: string, students: DueStudent[], opts: { asOf?: string; client?: typeof db | Tx } = {}): Promise<Map<string, StudentDues>> => {
    const client = opts.client ?? db;
    const asOf = toDate(opts.asOf ?? new Date().toISOString().slice(0, 10));
    const out = new Map<string, StudentDues>();
    if (!students.length) return out;
    const ids = students.map((s) => s.id);
    const classIds = [...new Set(students.map((s) => s.classId))];
    const [year, instalments, heads, structure, concessions, given, adjustments, paidLines, rule] = await Promise.all([
        client.academicYear.findUniqueOrThrow({ where: { id: yearId }, select: { startDate: true } }),
        client.feeInstalment.findMany({ where: { academicYearId: yearId }, orderBy: [{ dueDate: 'asc' }, { sortOrder: 'asc' }] }),
        feeHeads(),
        client.feeStructureLine.findMany({ where: { academicYearId: yearId, classId: { in: classIds } }, select: { classId: true, feeHeadId: true, instalmentId: true, amount: true } }),
        client.feeConcession.findMany({ where: { academicYearId: yearId, isActive: true }, include: { lines: true } }),
        client.studentFeeConcession.findMany({ where: { studentId: { in: ids }, concession: { academicYearId: yearId } }, select: { studentId: true, concessionId: true } }),
        client.feeAdjustment.findMany({ where: { studentId: { in: ids }, academicYearId: yearId }, select: { studentId: true, instalmentId: true, feeHeadId: true, isFine: true, amount: true } }),
        client.feeReceiptLine.findMany({
            where: { receipt: { studentId: { in: ids }, academicYearId: yearId, status: 'active' } },
            select: { instalmentId: true, feeHeadId: true, isFine: true, amount: true, receipt: { select: { studentId: true } } },
        }),
        fineRule(),
    ]);
    const { joinRule } = await getSettings({ joinRule: FEES.newStudentFrom });
    const headById = new Map(heads.map((h, i) => [h.id, { ...h, rank: i }]));
    const byClass = new Map<string, typeof structure>();
    for (const l of structure) byClass.set(l.classId, [...(byClass.get(l.classId) ?? []), l]);
    const givenTo = new Map<string, Set<string>>();
    for (const g of given) givenTo.set(g.studentId, (givenTo.get(g.studentId) ?? new Set()).add(g.concessionId));
    const sum = <T>(list: T[], key: (x: T) => string, amount: (x: T) => number) => {
        const m = new Map<string, number>();
        for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + amount(x));
        return m;
    };
    const k = (student: string, inst: string, head: string | null) => `${student}|${inst}|${head ?? 'fine'}`;
    const adj = sum(adjustments, (a) => k(a.studentId, a.instalmentId, a.isFine ? null : a.feeHeadId), (a) => a.amount);
    const paid = sum(paidLines, (p) => k(p.receipt.studentId, p.instalmentId, p.isFine ? null : p.feeHeadId), (p) => p.amount);

    for (const s of students) {
        const mine = concessions.filter((c) => (c.automatic ? matches(c, s) : givenTo.get(s.id)?.has(c.id)));
        const newcomer = s.admissionDate >= year.startDate;
        const lines = byClass.get(s.classId) ?? [];
        // A student admitted during the year pays from the instalment they join in (or the next one),
        // by System Settings → Fees; "new admissions only" heads of the skipped ones move to the first.
        let start = 0;
        if (newcomer && joinRule !== 'all') {
            const before = instalments.filter((i) => i.dueDate <= s.admissionDate).length;
            start = Math.min(joinRule === 'current' ? Math.max(0, before - 1) : before, Math.max(0, instalments.length - 1));
        }
        const carried = new Map<string, number>();
        for (const l of lines) {
            const idx = instalments.findIndex((i) => i.id === l.instalmentId);
            if (idx < start && headById.get(l.feeHeadId)?.oneTime) carried.set(l.feeHeadId, (carried.get(l.feeHeadId) ?? 0) + l.amount);
        }
        const result: DueInstalment[] = [];
        for (const [idx, inst] of instalments.entries()) {
            // A student who left owes nothing for instalments falling due after they left.
            if (s.status !== 'active' && s.statusDate && inst.dueDate > s.statusDate) continue;
            const headIds = new Set<string>();
            for (const l of lines) if (l.instalmentId === inst.id) headIds.add(l.feeHeadId);
            if (idx === start) for (const h of carried.keys()) headIds.add(h);
            for (const a of adjustments) if (a.studentId === s.id && a.instalmentId === inst.id && a.feeHeadId) headIds.add(a.feeHeadId);
            for (const p of paidLines) if (p.receipt.studentId === s.id && p.instalmentId === inst.id && p.feeHeadId) headIds.add(p.feeHeadId);
            const dl: DueLine[] = [];
            for (const headId of headIds) {
                const head = headById.get(headId);
                const own = idx < start ? 0 : lines.find((l) => l.instalmentId === inst.id && l.feeHeadId === headId)?.amount ?? 0;
                const structured = own + (idx === start ? carried.get(headId) ?? 0 : 0);
                const gross = head?.oneTime && !newcomer ? 0 : structured;
                let concession = 0;
                for (const c of mine) {
                    const cl = c.lines.find((x) => x.feeHeadId === headId);
                    if (cl) concession += cl.kind === 'percent' ? Math.round((gross * cl.value) / 100) : cl.value;
                }
                concession = Math.min(concession, gross);
                const adjustment = adj.get(k(s.id, inst.id, headId)) ?? 0;
                const net = Math.max(0, gross - concession + adjustment);
                const p = paid.get(k(s.id, inst.id, headId)) ?? 0;
                if (!net && !p) continue;
                dl.push({ feeHeadId: headId, head: head?.name ?? '—', gross, concession, adjustment, net, paid: p, balance: net - p });
            }
            dl.sort((a, b) => (headById.get(a.feeHeadId)?.rank ?? 999) - (headById.get(b.feeHeadId)?.rank ?? 999));
            const net = dl.reduce((a, l) => a + l.net, 0);
            const linePaid = dl.reduce((a, l) => a + l.paid, 0);
            const baseLeft = dl.reduce((a, l) => a + Math.max(0, l.balance), 0);
            const finePaid = paid.get(k(s.id, inst.id, null)) ?? 0;
            const waived = -(adj.get(k(s.id, inst.id, null)) ?? 0);
            // While something is unpaid the fine grows; once paid, it is what was actually paid.
            const charged = baseLeft > 0 ? Math.max(lateFine(rule, inst.dueDate, asOf), finePaid) : finePaid;
            const fineBalance = Math.max(0, charged - waived - finePaid);
            if (!dl.length && !charged) continue;
            result.push({
                id: inst.id,
                name: inst.name,
                dueDate: dayOf(inst.dueDate)!,
                lines: dl,
                fine: { charged, waived: Math.max(0, waived), paid: finePaid, balance: fineBalance },
                net,
                paid: linePaid + finePaid,
                balance: baseLeft + fineBalance,
                overdue: baseLeft + fineBalance > 0 && inst.dueDate < asOf,
            });
        }
        out.set(s.id, {
            studentId: s.id,
            instalments: result,
            concessions: mine.map((c) => ({ id: c.id, name: c.name, automatic: c.automatic })),
            totals: {
                net: result.reduce((a, i) => a + i.net, 0),
                paid: result.reduce((a, i) => a + i.paid, 0),
                fine: result.reduce((a, i) => a + i.fine.balance, 0),
                balance: result.reduce((a, i) => a + i.balance, 0),
                overdue: result.filter((i) => i.overdue).reduce((a, i) => a + i.balance, 0),
            },
        });
    }
    return out;
};

/** A student as the dues need them, in a year (their class from the enrolment of that year). */
export const dueStudents = async (yearId: string, where: object = {}, client: typeof db | Tx = db): Promise<(DueStudent & { sectionId: string })[]> => {
    const enrolments = await client.enrolment.findMany({
        where: { academicYearId: yearId, student: where },
        select: {
            sectionId: true,
            section: { select: { classId: true } },
            student: { select: { id: true, admissionDate: true, status: true, statusDate: true, genderId: true, casteCategoryId: true, categoryId: true } },
        },
    });
    return enrolments.map((e) => ({ ...e.student, classId: e.section.classId, sectionId: e.sectionId }));
};

export interface AllocationLine {
    instalmentId: string;
    feeHeadId: string | null;
    isFine: boolean;
    amount: number;
}

/**
 * Spreads a payment over the dues: oldest instalment first, heads in their order, then that
 * instalment's fine. `only` limits it to some instalments. Returns the lines and what is left over.
 */
export const allocate = (dues: StudentDues, amount: number, only?: string[]) => {
    const lines: AllocationLine[] = [];
    let left = amount;
    for (const inst of dues.instalments) {
        if (only && !only.includes(inst.id)) continue;
        for (const l of inst.lines) {
            if (left <= 0) break;
            const take = Math.min(left, Math.max(0, l.balance));
            if (take > 0) {
                lines.push({ instalmentId: inst.id, feeHeadId: l.feeHeadId, isFine: false, amount: take });
                left -= take;
            }
        }
        if (left > 0 && inst.fine.balance > 0) {
            const take = Math.min(left, inst.fine.balance);
            lines.push({ instalmentId: inst.id, feeHeadId: null, isFine: true, amount: take });
            left -= take;
        }
    }
    return { lines, left };
};

/** Whether every instalment touched by `lines` is then fully paid (for "no part payment"). */
export const coversWhole = (dues: StudentDues, lines: AllocationLine[]) => {
    const touched = new Set(lines.map((l) => l.instalmentId));
    return [...touched].every((id) => {
        const inst = dues.instalments.find((i) => i.id === id)!;
        return lines.filter((l) => l.instalmentId === id).reduce((a, l) => a + l.amount, 0) >= inst.balance;
    });
};
