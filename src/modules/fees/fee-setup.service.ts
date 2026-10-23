import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { classesOfYear } from '../academic/year-classes.service';

/** Fee set-up of a year: instalments, the structure (class × head × instalment), concessions. */

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const day = z.iso.date('must be a date like 2026-04-15');
const uuidOk = (id: string) => z.uuid().safeParse(id).success;

const yearOf = async (id: string) => {
    const y = uuidOk(id) ? await db.academicYear.findUnique({ where: { id } }) : null;
    if (!y) throw notFound('Academic year not found');
    return y;
};

/** Fee heads (master "fee_head") in their order; `oneTime` = only for new admissions. */
export const feeHeads = async (includeInactive = true) =>
    (await db.masterValue.findMany({ where: { master: 'fee_head', ...(includeInactive ? {} : { isActive: true }) }, select: { id: true, name: true, code: true, extra: true, isActive: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map(
        (h) => ({ id: h.id, name: h.name, code: h.code, isActive: h.isActive, oneTime: !!(h.extra as { one_time?: boolean }).one_time, refundable: !!(h.extra as { refundable?: boolean }).refundable })
    );

// ─── Instalments ─────────────────────────────────────────────────────────────

export const instalmentSchema = z.strictObject({ name: z.string().trim().min(1, 'is required').max(60), dueDate: day });

export const listInstalments = async (yearId: string) => {
    await yearOf(yearId);
    const rows = await db.feeInstalment.findMany({ where: { academicYearId: yearId }, orderBy: [{ dueDate: 'asc' }, { sortOrder: 'asc' }], include: { _count: { select: { receiptLines: true } } } });
    return rows.map((i) => ({ id: i.id, name: i.name, dueDate: dayOf(i.dueDate)!, paidAgainst: i._count.receiptLines > 0 }));
};

const checkInYear = (year: { startDate: Date; endDate: Date }, due: string) => {
    if (toDate(due) < year.startDate || toDate(due) > year.endDate) throw badRequest('The due date is outside the academic year', [{ field: 'dueDate', message: 'must be within the academic year' }]);
};

export const createInstalment = async (yearId: string, input: z.infer<typeof instalmentSchema>) => {
    const year = await yearOf(yearId);
    checkInYear(year, input.dueDate);
    if (await db.feeInstalment.findFirst({ where: { academicYearId: yearId, name: { equals: input.name, mode: 'insensitive' } } })) throw conflict(`There is already an instalment "${input.name}" this year`);
    await db.feeInstalment.create({ data: { tenantId: getTenantId()!, academicYearId: yearId, name: input.name, dueDate: toDate(input.dueDate) } });
    return listInstalments(yearId);
};

export const updateInstalment = async (id: string, input: Partial<z.infer<typeof instalmentSchema>>) => {
    const i = uuidOk(id) ? await db.feeInstalment.findUnique({ where: { id }, include: { academicYear: true } }) : null;
    if (!i) throw notFound('Instalment not found');
    if (input.dueDate) checkInYear(i.academicYear, input.dueDate);
    if (input.name && (await db.feeInstalment.findFirst({ where: { academicYearId: i.academicYearId, id: { not: id }, name: { equals: input.name, mode: 'insensitive' } } }))) throw conflict(`There is already an instalment "${input.name}" this year`);
    await db.feeInstalment.update({ where: { id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.dueDate ? { dueDate: toDate(input.dueDate) } : {}) } });
    return listInstalments(i.academicYearId);
};

export const deleteInstalment = async (id: string) => {
    const i = uuidOk(id) ? await db.feeInstalment.findUnique({ where: { id }, include: { _count: { select: { receiptLines: true, adjustments: true } } } }) : null;
    if (!i) throw notFound('Instalment not found');
    if (i._count.receiptLines || i._count.adjustments) throw conflict('Fees have been paid or changed against this instalment; it can no longer be removed');
    await db.feeInstalment.delete({ where: { id } });
    return listInstalments(i.academicYearId);
};

export const generateSchema = z.strictObject({
    plan: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']),
    /** Day of the month the instalments fall due. */
    dueDay: z.number().int().min(1).max(28).default(10),
});
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Makes the instalments of a plan, from the year's first month (only when the year has none). */
export const generateInstalments = async (yearId: string, input: z.infer<typeof generateSchema>) => {
    const year = await yearOf(yearId);
    if (await db.feeInstalment.count({ where: { academicYearId: yearId } })) throw conflict('This year already has instalments; change them one by one');
    const step = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 }[input.plan];
    const first = new Date(Date.UTC(year.startDate.getUTCFullYear(), year.startDate.getUTCMonth(), 1));
    const data: Prisma.FeeInstalmentCreateManyInput[] = [];
    for (let m = 0, n = 1; m < 12; m += step, n++) {
        const month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + m, 1));
        const due = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), input.dueDay));
        if (due > year.endDate) break;
        const name = input.plan === 'monthly' ? `${MONTHS[month.getUTCMonth()]} ${month.getUTCFullYear()}` : input.plan === 'yearly' ? 'Annual' : input.plan === 'quarterly' ? `Quarter ${n}` : `Half ${n}`;
        data.push({ tenantId: getTenantId()!, academicYearId: yearId, name, dueDate: due < year.startDate ? year.startDate : due, sortOrder: n });
    }
    await db.feeInstalment.createMany({ data });
    return listInstalments(yearId);
};

// ─── Structure ───────────────────────────────────────────────────────────────

/** The amounts of one class: heads × instalments. */
export const structureGrid = async (yearId: string, classId: string) => {
    await yearOf(yearId);
    const cls = uuidOk(classId) ? await db.schoolClass.findUnique({ where: { id: classId }, select: { id: true, name: true } }) : null;
    if (!cls) throw notFound('Class not found');
    const [heads, instalments, lines] = await Promise.all([
        feeHeads(),
        listInstalments(yearId),
        db.feeStructureLine.findMany({ where: { academicYearId: yearId, classId }, select: { feeHeadId: true, instalmentId: true, amount: true } }),
    ]);
    const used = new Set(lines.map((l) => l.feeHeadId));
    return {
        class: cls,
        heads: heads.filter((h) => h.isActive || used.has(h.id)),
        instalments,
        amounts: lines,
        total: lines.reduce((a, l) => a + l.amount, 0),
    };
};

export const structureSchema = z.strictObject({
    /** The class's complete structure (cells not listed are removed). */
    amounts: z.array(z.strictObject({ feeHeadId: z.uuid(), instalmentId: z.uuid(), amount: z.number().int('whole rupees').min(0).max(10_000_000) })).max(2000),
});

export const saveStructure = async (yearId: string, classId: string, input: z.infer<typeof structureSchema>) => {
    const grid = await structureGrid(yearId, classId);
    const heads = new Set((await feeHeads()).map((h) => h.id));
    const inst = new Set(grid.instalments.map((i) => i.id));
    const seen = new Set<string>();
    for (const a of input.amounts) {
        if (!heads.has(a.feeHeadId)) throw badRequest('A fee head is not in the list (Masters → Fee heads)');
        if (!inst.has(a.instalmentId)) throw badRequest("An instalment is not one of this year's");
        const k = `${a.feeHeadId}:${a.instalmentId}`;
        if (seen.has(k)) throw badRequest('The same head and instalment appear twice');
        seen.add(k);
    }
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.feeStructureLine.deleteMany({ where: { academicYearId: yearId, classId } });
        const data = input.amounts.filter((a) => a.amount > 0).map((a) => ({ tenantId, academicYearId: yearId, classId, ...a }));
        if (data.length) await tx.feeStructureLine.createMany({ data });
    });
    await recordAudit({ action: 'fee_structure', entity: 'class', entityId: classId, changes: { academicYearId: yearId, total: input.amounts.reduce((a, x) => a + x.amount, 0) } });
    return structureGrid(yearId, classId);
};

export const copyStructureSchema = z.strictObject({
    toClassIds: z.array(z.uuid()).min(1).max(40),
});

/** The same amounts for other classes of the year (their own structure is replaced). */
export const copyStructure = async (yearId: string, fromClassId: string, input: z.infer<typeof copyStructureSchema>) => {
    const from = await structureGrid(yearId, fromClassId);
    const targets = await db.schoolClass.findMany({ where: { id: { in: input.toClassIds.filter((c) => c !== fromClassId) } }, select: { id: true } });
    const tenantId = getTenantId()!;
    await withTransaction(async (tx) => {
        await tx.feeStructureLine.deleteMany({ where: { academicYearId: yearId, classId: { in: targets.map((t) => t.id) } } });
        const data = targets.flatMap((t) => from.amounts.map((a) => ({ tenantId, academicYearId: yearId, classId: t.id, feeHeadId: a.feeHeadId, instalmentId: a.instalmentId, amount: a.amount })));
        if (data.length) await tx.feeStructureLine.createMany({ data });
    });
    return { classes: targets.length };
};

/** Every class's yearly total, for the set-up overview. */
export const structureOverview = async (yearId: string) => {
    await yearOf(yearId);
    const classes = (await classesOfYear(yearId)).map((c) => ({ id: c.id, name: c.name }));
    const sums = await db.feeStructureLine.groupBy({ by: ['classId'], where: { academicYearId: yearId }, _sum: { amount: true } });
    const total = new Map(sums.map((s) => [s.classId, s._sum.amount ?? 0]));
    return classes.map((c) => ({ ...c, total: total.get(c.id) ?? 0 }));
};

export const copyYearSchema = z.strictObject({ fromYearId: z.uuid() });

/** Copies last year's instalments (same months, a year on), structure and concessions into an empty year. */
export const copyFromYear = async (yearId: string, input: z.infer<typeof copyYearSchema>) => {
    const year = await yearOf(yearId);
    const from = await yearOf(input.fromYearId);
    if (yearId === from.id) throw badRequest('Choose another year to copy from');
    if (await db.feeInstalment.count({ where: { academicYearId: yearId } })) throw conflict('This year already has instalments; copying needs an empty year');
    const oldInst = await db.feeInstalment.findMany({ where: { academicYearId: from.id }, orderBy: { dueDate: 'asc' } });
    const shift = year.startDate.getUTCFullYear() - from.startDate.getUTCFullYear();
    const tenantId = getTenantId()!;
    const result = await withTransaction(
        async (tx) => {
            const map = new Map<string, string>();
            for (const i of oldInst) {
                const due = new Date(Date.UTC(i.dueDate.getUTCFullYear() + shift, i.dueDate.getUTCMonth(), i.dueDate.getUTCDate()));
                const created = await tx.feeInstalment.create({ data: { tenantId, academicYearId: yearId, name: i.name.replace(String(i.dueDate.getUTCFullYear()), String(due.getUTCFullYear())), dueDate: due, sortOrder: i.sortOrder } });
                map.set(i.id, created.id);
            }
            const lines = await tx.feeStructureLine.findMany({ where: { academicYearId: from.id } });
            if (lines.length) await tx.feeStructureLine.createMany({ data: lines.map((l) => ({ tenantId, academicYearId: yearId, classId: l.classId, feeHeadId: l.feeHeadId, instalmentId: map.get(l.instalmentId)!, amount: l.amount })) });
            const concessions = await tx.feeConcession.findMany({ where: { academicYearId: from.id }, include: { lines: true } });
            for (const c of concessions) {
                await tx.feeConcession.create({
                    data: {
                        tenantId,
                        academicYearId: yearId,
                        name: c.name,
                        automatic: c.automatic,
                        genderIds: c.genderIds,
                        casteCategoryIds: c.casteCategoryIds,
                        categoryIds: c.categoryIds,
                        classIds: c.classIds,
                        note: c.note,
                        isActive: c.isActive,
                        lines: { create: c.lines.map((l) => ({ feeHeadId: l.feeHeadId, kind: l.kind, value: l.value })) },
                    },
                });
            }
            return { instalments: oldInst.length, amounts: lines.length, concessions: concessions.length };
        },
        { timeout: 60_000 }
    );
    return result;
};

// ─── Concessions ─────────────────────────────────────────────────────────────

export const concessionSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(80),
    automatic: z.boolean(),
    genderIds: z.array(z.uuid()).max(10).default([]),
    casteCategoryIds: z.array(z.uuid()).max(20).default([]),
    categoryIds: z.array(z.uuid()).max(20).default([]),
    classIds: z.array(z.uuid()).max(40).default([]),
    note: z.union([z.literal('').transform(() => null), z.string().trim().max(300), z.null()]).optional(),
    isActive: z.boolean().default(true),
    lines: z
        .array(z.strictObject({ feeHeadId: z.uuid(), kind: z.enum(['percent', 'amount']), value: z.number().int('whole numbers').min(0).max(10_000_000) }))
        .min(1, 'choose at least one fee head')
        .max(30),
});

const presentConcession = (c: Prisma.FeeConcessionGetPayload<{ include: { lines: { include: { feeHead: { select: { id: true; name: true } } } }; _count: { select: { students: true } } } }>) => ({
    id: c.id,
    name: c.name,
    automatic: c.automatic,
    genderIds: c.genderIds,
    casteCategoryIds: c.casteCategoryIds,
    categoryIds: c.categoryIds,
    classIds: c.classIds,
    note: c.note,
    isActive: c.isActive,
    students: c._count.students,
    lines: c.lines.map((l) => ({ feeHeadId: l.feeHeadId, feeHead: l.feeHead, kind: l.kind, value: l.value })),
});
const concessionInclude = { lines: { include: { feeHead: { select: { id: true, name: true } } } }, _count: { select: { students: true } } } as const;

export const listConcessions = async (yearId: string) => {
    await yearOf(yearId);
    return (await db.feeConcession.findMany({ where: { academicYearId: yearId }, include: concessionInclude, orderBy: { name: 'asc' } })).map(presentConcession);
};

const checkConcession = async (input: z.infer<typeof concessionSchema>) => {
    const issues: { field: string; message: string }[] = [];
    if (input.lines.some((l) => l.kind === 'percent' && l.value > 100)) issues.push({ field: 'lines', message: 'a percent can be at most 100' });
    if (new Set(input.lines.map((l) => l.feeHeadId)).size !== input.lines.length) issues.push({ field: 'lines', message: 'a fee head appears twice' });
    const want: [string[], string, string][] = [
        [input.genderIds, 'gender', 'genderIds'],
        [input.casteCategoryIds, 'caste_category', 'casteCategoryIds'],
        [input.categoryIds, 'student_category', 'categoryIds'],
        [input.lines.map((l) => l.feeHeadId), 'fee_head', 'lines'],
    ];
    for (const [ids, master, field] of want) {
        if (ids.length && (await db.masterValue.count({ where: { id: { in: ids }, master } })) !== new Set(ids).size) issues.push({ field, message: 'has an option that is not in its list' });
    }
    if (input.classIds.length && (await db.schoolClass.count({ where: { id: { in: input.classIds } } })) !== new Set(input.classIds).size) issues.push({ field: 'classIds', message: 'has a class that was not found' });
    if (input.automatic && !input.genderIds.length && !input.casteCategoryIds.length && !input.categoryIds.length && !input.classIds.length) {
        issues.push({ field: 'automatic', message: 'an automatic concession needs at least one condition (else it would apply to everyone)' });
    }
    if (issues.length) throw badRequest(issues.length === 1 ? issues[0].message : 'Some fields need attention', issues);
};

export const createConcession = async (yearId: string, input: z.infer<typeof concessionSchema>) => {
    await yearOf(yearId);
    await checkConcession(input);
    if (await db.feeConcession.findFirst({ where: { academicYearId: yearId, name: { equals: input.name, mode: 'insensitive' } } })) throw conflict(`There is already a concession "${input.name}" this year`);
    const tenantId = getTenantId()!;
    const { lines, ...rest } = input;
    const c = await db.feeConcession.create({ data: { tenantId, academicYearId: yearId, ...rest, lines: { create: lines.map((l) => ({ ...l })) } }, include: concessionInclude });
    return presentConcession(c);
};

export const updateConcession = async (id: string, input: z.infer<typeof concessionSchema>) => {
    const current = uuidOk(id) ? await db.feeConcession.findUnique({ where: { id } }) : null;
    if (!current) throw notFound('Concession not found');
    await checkConcession(input);
    if (await db.feeConcession.findFirst({ where: { academicYearId: current.academicYearId, id: { not: id }, name: { equals: input.name, mode: 'insensitive' } } })) throw conflict(`There is already a concession "${input.name}" this year`);
    const { lines, ...rest } = input;
    await withTransaction(async (tx) => {
        await tx.feeConcessionLine.deleteMany({ where: { concessionId: id } });
        await tx.feeConcession.update({ where: { id }, data: { ...rest, lines: { create: lines.map((l) => ({ ...l })) } } });
    });
    return presentConcession(await db.feeConcession.findUniqueOrThrow({ where: { id }, include: concessionInclude }));
};

export const deleteConcession = async (id: string) => {
    const c = uuidOk(id) ? await db.feeConcession.findUnique({ where: { id }, include: { _count: { select: { students: true } } } }) : null;
    if (!c) throw notFound('Concession not found');
    if (c._count.students) throw conflict(`${c._count.students} student(s) have this concession; take it off them first, or switch it off`);
    await db.feeConcession.delete({ where: { id } });
    return { id };
};
