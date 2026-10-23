import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { logger } from '../../core/logger';
import { revokeUserSessions } from '../auth/session.service';
import { fullName } from '../students/students.service';
import { renumberSection, saveEnrolment } from '../students/enrolment.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { summaries } from '../attendance/student-attendance.service';
import { computeDues, dueStudents } from '../fees/dues.service';
import { PROMOTION } from './promotion.settings';

/**
 * Promotion: at the end of a session each student of a section is promoted to the next class, kept
 * back, passed out (last class) or leaving (a TC is asked for). Promoted and kept-back students are
 * placed in the next session (same section letter by default, roll numbers by the school's rule),
 * and fees still due can be carried there. Every promotion is recorded so it can be undone while the
 * new session hasn't been used for the student.
 */

const uuidOk = (id: string) => z.uuid().safeParse(id).success;

const yearById = async (id: string) => {
    if (!uuidOk(id)) throw notFound('Academic year not found');
    const y = await db.academicYear.findUnique({ where: { id } });
    if (!y) throw notFound('Academic year not found');
    return y;
};

/** The session after this one (starts the day after it ends, or the next one by date). */
export const nextYearOf = async (yearId: string) => {
    const y = await yearById(yearId);
    return db.academicYear.findFirst({ where: { startDate: { gt: y.startDate } }, orderBy: { startDate: 'asc' } });
};

/** The class a class's students move up to in a session: its "next class" if it runs there, else the next by order. */
export const nextClassIn = async (classId: string, toYearId: string) => {
    const [from, running] = await Promise.all([
        db.schoolClass.findUnique({ where: { id: classId }, select: { id: true, sortOrder: true, nextClassId: true } }),
        db.yearClass.findMany({ where: { academicYearId: toYearId, schoolClass: { isActive: true } }, select: { schoolClass: { select: { id: true, name: true, shortName: true, sortOrder: true } } } }),
    ]);
    if (!from) return null;
    const classes = running.map((r) => r.schoolClass).sort((a, b) => a.sortOrder - b.sortOrder);
    if (from.nextClassId) {
        const set = classes.find((c) => c.id === from.nextClassId);
        if (set) return set;
    }
    return classes.find((c) => c.sortOrder > from.sortOrder) ?? null;
};

// ─── The overview: every section of a session and how far its promotion is ──

export const overviewQuery = z.object({ year: z.uuid() });

export const promotionOverview = async (yearId: string) => {
    const from = await yearById(yearId);
    const to = await nextYearOf(yearId);
    const sections = await db.section.findMany({
        where: { academicYearId: yearId, isActive: true },
        select: { id: true, name: true, classId: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } }, _count: { select: { enrolments: { where: { student: { status: 'active' } } } } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    const done = await db.studentPromotion.groupBy({ by: ['fromSectionId', 'outcome'], where: { fromYearId: yearId }, _count: { _all: true } });
    const nextOf = new Map<string, { id: string; name: string } | null>();
    if (to) for (const c of new Set(sections.map((s) => s.classId))) nextOf.set(c, await nextClassIn(c, to.id));
    return {
        from: { id: from.id, name: from.name, status: from.status },
        to: to ? { id: to.id, name: to.name, status: to.status } : null,
        sections: sections.map((s) => {
            const mine = done.filter((d) => d.fromSectionId === s.id);
            const count = (o: string) => mine.find((d) => d.outcome === o)?._count._all ?? 0;
            const promoted = count('promoted');
            const finished = mine.reduce((a, d) => a + d._count._all, 0);
            return {
                id: s.id,
                label: sectionLabel(s),
                className: s.schoolClass.name,
                students: s._count.enrolments + count('passed_out') + count('leaving'),
                done: finished,
                promoted,
                detained: count('detained'),
                passedOut: count('passed_out'),
                leaving: count('leaving'),
                nextClass: to ? (nextOf.get(s.classId)?.name ?? null) : null,
            };
        }),
    };
};

// ─── One section: its students and what happens to each ─────────────────────

export const sectionQuery = z.object({ year: z.uuid(), section: z.uuid() });

export const sectionPromotion = async (yearId: string, sectionId: string) => {
    const from = await yearById(yearId);
    const to = await nextYearOf(yearId);
    if (!uuidOk(sectionId)) throw notFound('Section not found');
    const section = await db.section.findFirst({ where: { id: sectionId, academicYearId: yearId }, select: { id: true, name: true, classId: true, schoolClass: { select: { name: true, shortName: true } } } });
    if (!section) throw notFound('Section not found');
    const next = to ? await nextClassIn(section.classId, to.id) : null;
    const [targets, sameClass] = to
        ? await Promise.all([
              next ? db.section.findMany({ where: { academicYearId: to.id, classId: next.id, isActive: true }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: { sortOrder: 'asc' } }) : [],
              db.section.findMany({ where: { academicYearId: to.id, classId: section.classId, isActive: true }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: { sortOrder: 'asc' } }),
          ])
        : [[], []];
    const { rule } = await getSettings({ rule: PROMOTION.sectionRule });
    const pick = (list: { id: string; name: string }[]) => (rule === 'same_letter' ? (list.find((s) => s.name === section.name) ?? list[0]) : list[0])?.id ?? null;
    const enrolments = await db.enrolment.findMany({
        where: { academicYearId: yearId, sectionId },
        select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, status: true } } },
        orderBy: [{ rollNumber: 'asc' }, { student: { firstName: 'asc' } }],
    });
    const done = new Map((await db.studentPromotion.findMany({ where: { fromYearId: yearId, studentId: { in: enrolments.map((e) => e.student.id) } } })).map((p) => [p.studentId, p]));
    // Students who left during the session (not through promotion) aren't promoted.
    const rows = enrolments.filter((e) => e.student.status === 'active' || done.has(e.student.id));
    const ids = rows.map((r) => r.student.id);
    const end = isoOf(from.endDate) < todayIST() ? isoOf(from.endDate) : todayIST();
    const [attendance, dues] = await Promise.all([summaries(ids, isoOf(from.startDate), end), computeDues(yearId, await dueStudents(yearId, { id: { in: ids } }))]);
    const targetLabel = new Map([...targets, ...sameClass].map((s) => [s.id, sectionLabel(s)]));
    return {
        from: { id: from.id, name: from.name },
        to: to ? { id: to.id, name: to.name, status: to.status } : null,
        section: { id: section.id, label: sectionLabel(section), className: section.schoolClass.name },
        nextClass: next ? { id: next.id, name: next.name } : null,
        /** Why promotion can't start, in words. */
        missing: !to
            ? `Add the next session first (Academic → Academic Years).`
            : to.status === 'closed'
              ? `${to.name} is closed. Reopen it first.`
              : next && !targets.length
                ? `${to.name} has no sections for ${next.name} yet (Academic → Classes & Sections).`
                : null,
        targets: targets.map((s) => ({ id: s.id, label: sectionLabel(s) })),
        sameClassSections: sameClass.map((s) => ({ id: s.id, label: sectionLabel(s) })),
        students: rows.map((r) => {
            const d = dues.get(r.student.id);
            const p = done.get(r.student.id);
            return {
                id: r.student.id,
                name: fullName(r.student),
                admissionNo: r.student.admissionNo,
                roll: r.rollNumber,
                attendance: attendance.get(r.student.id)?.percent ?? null,
                dues: d?.totals.balance ?? 0,
                done: p ? { outcome: p.outcome, toSection: p.toSectionId ? (targetLabel.get(p.toSectionId) ?? null) : null, carried: p.carriedAmount, at: p.createdAt } : null,
                suggestion: next ? { outcome: 'promoted', toSectionId: pick(targets) } : { outcome: 'passed_out', toSectionId: null },
            };
        }),
        defaults: { promoted: pick(targets), detained: pick(sameClass) },
    };
};

// ─── Promoting ───────────────────────────────────────────────────────────────

export const promoteSchema = z.strictObject({
    year: z.uuid(),
    section: z.uuid(),
    students: z
        .array(z.strictObject({ studentId: z.uuid(), outcome: z.enum(['promoted', 'detained', 'passed_out', 'leaving']), toSectionId: z.uuid().nullable().optional() }))
        .min(1, 'choose at least one student')
        .max(200),
});

/** The fee head old dues are carried under (made the first time). */
const previousDuesHead = async (client: typeof db | Tx) => {
    const found = await client.masterValue.findFirst({ where: { master: 'fee_head', code: 'PREV' }, select: { id: true } });
    if (found) return found.id;
    const first = await client.masterValue.findFirst({ where: { master: 'fee_head' }, orderBy: { sortOrder: 'asc' }, select: { sortOrder: true } });
    // First in order, so part payments clear old dues before this session's fees.
    return (await client.masterValue.create({ data: { tenantId: getTenantId()!, master: 'fee_head', name: 'Previous session dues', code: 'PREV', sortOrder: (first?.sortOrder ?? 1) - 1, extra: { one_time: false, refundable: false } } })).id;
};

/** Moves what a student still owes in the old session to the new one (old balance becomes zero). */
const carryDues = async (tx: Tx, studentId: string, fromYear: { id: string; name: string }, toYear: { id: string; name: string }) => {
    const students = await dueStudents(fromYear.id, { id: studentId }, tx);
    const d = (await computeDues(fromYear.id, students, { client: tx })).get(studentId);
    const lines = (d?.instalments ?? []).flatMap((i) => i.lines.filter((l) => l.balance > 0).map((l) => ({ instalmentId: i.id, feeHeadId: l.feeHeadId, balance: l.balance })));
    const total = lines.reduce((a, l) => a + l.balance, 0);
    if (!total) return { ids: [], amount: 0 };
    const first = await tx.feeInstalment.findFirst({ where: { academicYearId: toYear.id }, orderBy: [{ dueDate: 'asc' }, { sortOrder: 'asc' }], select: { id: true } });
    if (!first) return { ids: [], amount: 0, skipped: true };
    const tenantId = getTenantId()!;
    const head = await previousDuesHead(tx);
    const made = await tx.feeAdjustment.createManyAndReturn({
        data: [
            ...lines.map((l) => ({ tenantId, studentId, academicYearId: fromYear.id, instalmentId: l.instalmentId, feeHeadId: l.feeHeadId, amount: -l.balance, reason: `Carried to ${toYear.name}` })),
            { tenantId, studentId, academicYearId: toYear.id, instalmentId: first.id, feeHeadId: head, amount: total, reason: `Dues of ${fromYear.name}` },
        ],
        select: { id: true },
    });
    return { ids: made.map((m) => m.id), amount: total };
};

export const promote = async (input: z.infer<typeof promoteSchema>, userId: string) => {
    const view = await sectionPromotion(input.year, input.section);
    if (!view.to) throw badRequest(view.missing ?? 'Add the next session first');
    if (view.to.status === 'closed') throw conflict(`${view.to.name} is closed. Reopen it first.`);
    const to = view.to;
    const from = view.from;
    const byId = new Map(view.students.map((s) => [s.id, s]));
    const allowed = { promoted: new Set(view.targets.map((t) => t.id)), detained: new Set(view.sameClassSections.map((t) => t.id)) };
    for (const r of input.students) {
        const s = byId.get(r.studentId);
        if (!s) throw badRequest('A student chosen is not in this section');
        if (s.done) throw conflict(`${s.name} has already been done. Undo it first to change it.`);
        if (r.outcome === 'promoted' && !view.nextClass) throw badRequest(`${view.section.className} is the last class: choose “Passed out”`);
        if ((r.outcome === 'promoted' || r.outcome === 'detained') && (!r.toSectionId || !allowed[r.outcome].has(r.toSectionId)))
            throw badRequest(r.outcome === 'promoted' ? `Choose a section of ${view.nextClass?.name} in ${to.name} for ${s.name}` : `Choose a section of ${view.section.className} in ${to.name} for ${s.name}`);
    }
    const { roll, carry } = await getSettings({ roll: PROMOTION.rollRule, carry: PROMOTION.carryDues });
    const old = new Map((await db.enrolment.findMany({ where: { academicYearId: from.id, studentId: { in: input.students.map((s) => s.studentId) } }, select: { studentId: true, rollNumber: true } })).map((e) => [e.studentId, e.rollNumber]));
    const tenantId = getTenantId()!;
    const fromYear = await yearById(from.id);
    const result = { promoted: 0, detained: 0, passedOut: 0, leaving: 0, carried: 0, warnings: [] as string[] };
    const touched = new Set<string>();
    for (const r of input.students) {
        const name = byId.get(r.studentId)!.name;
        try {
            await withTransaction(async (tx) => {
                let carried: { ids: string[]; amount: number; skipped?: boolean } = { ids: [], amount: 0 };
                if (r.outcome === 'promoted' || r.outcome === 'detained') {
                    const placed = await saveEnrolment(r.studentId, { academicYearId: to.id, sectionId: r.toSectionId!, rollNumber: roll === 'keep' ? (old.get(r.studentId) ?? null) : roll === 'blank' ? null : undefined }, tx);
                    if (placed.warning) result.warnings.push(`${name}: ${placed.warning}`);
                    touched.add(r.toSectionId!);
                    if (carry) carried = await carryDues(tx, r.studentId, from, to);
                    if (carried.skipped) result.warnings.push(`${name}: ${to.name} has no fee instalments yet, so the dues stay in ${from.name}`);
                }
                if (r.outcome === 'passed_out') await tx.student.update({ where: { id: r.studentId }, data: { status: 'passed_out', statusDate: fromYear.endDate } });
                if (r.outcome === 'leaving') {
                    const open = await tx.transferCertificate.findFirst({ where: { studentId: r.studentId, status: 'requested' }, select: { id: true } });
                    if (!open)
                        await tx.transferCertificate.create({ data: { tenantId, studentId: r.studentId, applicationDate: new Date(`${todayIST()}T00:00:00Z`), leavingDate: fromYear.endDate, lastClass: view.section.className, requestedBy: userId } });
                }
                await tx.studentPromotion.create({
                    data: { tenantId, studentId: r.studentId, fromYearId: from.id, toYearId: to.id, fromSectionId: view.section.id, toSectionId: r.toSectionId ?? null, outcome: r.outcome, carriedAdjustmentIds: carried.ids, carriedAmount: carried.amount, createdBy: userId },
                });
                result.carried += carried.amount;
            });
            result[r.outcome === 'passed_out' ? 'passedOut' : r.outcome]++;
        } catch (err) {
            result.warnings.push(`${name}: ${(err as Error).message}`);
        }
    }
    // Passed out: their login stops.
    const gone = await db.student.findMany({ where: { id: { in: input.students.filter((r) => r.outcome === 'passed_out').map((r) => r.studentId) }, userId: { not: null } }, select: { userId: true } });
    for (const g of gone) {
        await db.user.update({ where: { id: g.userId! }, data: { status: 'disabled' } });
        await revokeUserSessions(g.userId!, 'admin');
    }
    if (roll === 'renumber') for (const sid of touched) await renumberSection(sid).catch((err) => logger.info('Roll numbers not given again', { section: sid, reason: (err as Error).message }));
    await recordAudit({ action: 'students_promoted', entity: 'section', entityId: view.section.id, changes: { from: from.name, to: to.name, ...result, warnings: result.warnings.length } });
    return { ...result, view: await sectionPromotion(input.year, input.section) };
};

// ─── Undo ────────────────────────────────────────────────────────────────────

export const undoSchema = z.strictObject({ year: z.uuid(), studentIds: z.array(z.uuid()).min(1).max(200) });

/** Takes back promotions: only while the new session hasn't been used for the student. */
export const undoPromotion = async (input: z.infer<typeof undoSchema>) => {
    const rows = await db.studentPromotion.findMany({ where: { fromYearId: input.year, studentId: { in: input.studentIds } }, include: { student: { select: { firstName: true, middleName: true, lastName: true, userId: true } } } });
    const out = { undone: 0, warnings: [] as string[] };
    for (const p of rows) {
        const name = fullName(p.student);
        if (p.toYearId) {
            const [marks, receipts] = await Promise.all([
                db.attendanceMark.count({ where: { studentId: p.studentId, sheet: { section: { academicYearId: p.toYearId } } } }),
                db.feeReceipt.count({ where: { studentId: p.studentId, academicYearId: p.toYearId, status: 'active' } }),
            ]);
            if (marks || receipts) {
                out.warnings.push(`${name}: the new session already has ${marks ? 'attendance' : ''}${marks && receipts ? ' and ' : ''}${receipts ? 'fee receipts' : ''} for them`);
                continue;
            }
        }
        await withTransaction(async (tx) => {
            if (p.toYearId && (p.outcome === 'promoted' || p.outcome === 'detained')) await tx.enrolment.deleteMany({ where: { studentId: p.studentId, academicYearId: p.toYearId } });
            if (p.carriedAdjustmentIds.length) await tx.feeAdjustment.deleteMany({ where: { id: { in: p.carriedAdjustmentIds } } });
            if (p.outcome === 'passed_out') await tx.student.update({ where: { id: p.studentId }, data: { status: 'active', statusDate: null } });
            if (p.outcome === 'leaving') await tx.transferCertificate.deleteMany({ where: { studentId: p.studentId, status: 'requested' } });
            await tx.studentPromotion.delete({ where: { id: p.id } });
        });
        if (p.outcome === 'passed_out' && p.student.userId) await db.user.update({ where: { id: p.student.userId }, data: { status: 'active' } });
        out.undone++;
    }
    await recordAudit({ action: 'promotion_undone', entity: 'academic_year', entityId: input.year, changes: { undone: out.undone } });
    return out;
};

