import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { cleanName } from '../masters/masters.service';
import { assertYearOpen } from './years.service';

/** The school's subjects, and which ones each class studies in a year. */

export const subjectInputSchema = z.strictObject({
    name: z.string().transform(cleanName).pipe(z.string().min(1, 'is required').max(80, 'must be at most 80 characters')),
    code: z
        .union([z.literal('').transform(() => null), z.string().trim().max(20, 'must be at most 20 characters').regex(/^[A-Za-z0-9._/-]+$/, 'use letters, numbers, dots or dashes'), z.null()])
        .optional(),
    typeId: z.uuid('choose a type').nullable().optional(),
    assessment: z.enum(['scholastic', 'co_scholastic']).optional(),
    isActive: z.boolean().optional(),
});
export const subjectUpdateSchema = subjectInputSchema.partial();

const subjectInclude = { type: { select: { id: true, name: true } }, _count: { select: { classSubjects: true } } } as const;
type SubjectRow = Prisma.SubjectGetPayload<{ include: typeof subjectInclude }>;

const present = (s: SubjectRow) => ({
    id: s.id,
    name: s.name,
    code: s.code,
    type: s.type,
    assessment: s.assessment,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
    /** How many class / year links use it. */
    usedBy: s._count.classSubjects,
});

export const listSubjects = async () => (await db.subject.findMany({ include: subjectInclude, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map(present);

export const subjectOptions = () =>
    db.subject.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true, assessment: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });

const getSubject = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Subject not found');
    const s = await db.subject.findUnique({ where: { id }, include: subjectInclude });
    if (!s) throw notFound('Subject not found');
    return present(s);
};

const checkSubject = async (input: { name: string; code?: string | null; typeId?: string | null }, exceptId?: string) => {
    const except = exceptId ? { id: { not: exceptId } } : {};
    if (await db.subject.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, ...except } })) throw conflict(`There is already a subject called ${input.name}`);
    if (input.code) {
        const other = await db.subject.findFirst({ where: { code: { equals: input.code, mode: 'insensitive' }, ...except }, select: { name: true } });
        if (other) throw conflict(`The code ${input.code} is already used by ${other.name}`);
    }
    if (input.typeId && !(await db.masterValue.findFirst({ where: { id: input.typeId, master: 'subject_type' } }))) {
        throw badRequest('Choose a subject type from the list', [{ field: 'typeId', message: 'is not a subject type' }]);
    }
};

export const createSubject = async (input: z.infer<typeof subjectInputSchema>) => {
    await checkSubject(input);
    const last = await db.subject.aggregate({ _max: { sortOrder: true } });
    const s = await db.subject.create({
        data: {
            tenantId: getTenantId()!,
            name: input.name,
            code: input.code ?? null,
            typeId: input.typeId ?? null,
            assessment: input.assessment ?? 'scholastic',
            isActive: input.isActive ?? true,
            sortOrder: (last._max.sortOrder ?? 0) + 10,
        },
    });
    return getSubject(s.id);
};

export const updateSubject = async (id: string, input: z.infer<typeof subjectUpdateSchema>) => {
    const current = await getSubject(id);
    const merged = { name: input.name ?? current.name, code: input.code === undefined ? current.code : input.code, typeId: input.typeId === undefined ? current.type?.id ?? null : input.typeId };
    await checkSubject(merged, id);
    await db.subject.update({
        where: { id },
        data: { ...merged, ...(input.assessment ? { assessment: input.assessment } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) },
    });
    return getSubject(id);
};

export const deleteSubject = async (id: string) => {
    const s = await getSubject(id);
    if (s.usedBy) throw conflict(`${s.name} is taught in ${s.usedBy} class${s.usedBy === 1 ? '' : 'es'} (this or an earlier year). Make it inactive instead.`);
    await db.subject.delete({ where: { id } });
    return { id, deleted: true };
};

export const moveSubject = async (id: string, direction: 'up' | 'down') => {
    await getSubject(id);
    await withTransaction(async (tx) => {
        const rows = await tx.subject.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, sortOrder: true } });
        const i = rows.findIndex((r) => r.id === id);
        const j = direction === 'up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= rows.length) return;
        [rows[i], rows[j]] = [rows[j], rows[i]];
        for (const [n, r] of rows.entries()) if (r.sortOrder !== (n + 1) * 10) await tx.subject.update({ where: { id: r.id }, data: { sortOrder: (n + 1) * 10 } });
    });
    return listSubjects();
};

// ─── Subjects per class ──────────────────────────────────────────────────────

/** A class's subjects in a year: the common ones (stream empty) and, for XI–XII, per stream. */
export const getClassSubjects = async (yearId: string, classId: string) => {
    const rows = await db.classSubject.findMany({
        where: { academicYearId: yearId, classId },
        include: { subject: { select: { id: true, name: true, code: true, assessment: true, isActive: true } }, stream: { select: { id: true, name: true } } },
        orderBy: [{ sortOrder: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, streamId: r.streamId, stream: r.stream, subject: r.subject, isOptional: r.isOptional, sortOrder: r.sortOrder }));
};

export const classSubjectsSchema = z.strictObject({
    academicYearId: z.uuid('choose an academic year'),
    classId: z.uuid('choose a class'),
    /** Empty = the subjects common to every stream (or a class without streams). */
    streamId: z.uuid('choose a stream').nullable(),
    subjects: z.array(z.strictObject({ subjectId: z.uuid(), isOptional: z.boolean() })).max(60),
});

/** Replaces the subjects of one class (and stream) in a year, in the given order. */
export const setClassSubjects = async (input: z.infer<typeof classSubjectsSchema>) => {
    const year = await assertYearOpen(input.academicYearId);
    const cls = await db.schoolClass.findUnique({ where: { id: input.classId }, select: { name: true, hasStreams: true } });
    if (!cls) throw badRequest('Choose a class', [{ field: 'classId', message: 'is not a class' }]);
    if (input.streamId && !cls.hasStreams) throw badRequest(`${cls.name} has no streams`, [{ field: 'streamId', message: 'this class has no streams' }]);
    if (input.streamId && !(await db.masterValue.findFirst({ where: { id: input.streamId, master: 'stream' } }))) throw badRequest('Choose a stream from the list', [{ field: 'streamId', message: 'is not a stream' }]);

    const ids = input.subjects.map((s) => s.subjectId);
    if (new Set(ids).size !== ids.length) throw badRequest('A subject is listed twice', [{ field: 'subjects', message: 'has the same subject twice' }]);
    const found = await db.subject.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    if (found.length !== ids.length) throw badRequest('Some subjects were not found', [{ field: 'subjects', message: 'contains an unknown subject' }]);
    const nameOf = new Map(found.map((s) => [s.id, s.name]));

    // A subject common to all streams can't also be set for one stream (and the other way round).
    if (cls.hasStreams && ids.length) {
        const clash = await db.classSubject.findFirst({
            where: { academicYearId: input.academicYearId, classId: input.classId, subjectId: { in: ids }, ...(input.streamId ? { streamId: null } : { streamId: { not: null } }) },
            select: { subjectId: true },
        });
        if (clash) throw conflict(`${nameOf.get(clash.subjectId)} is already set ${input.streamId ? 'for every stream' : 'for a stream'} of ${cls.name}`);
    }

    const tenantId = getTenantId()!;
    const where = { academicYearId: input.academicYearId, classId: input.classId, streamId: input.streamId };
    const before = await db.classSubject.findMany({ where, select: { subjectId: true, isOptional: true } });
    await withTransaction(async (tx) => {
        await tx.classSubject.deleteMany({ where });
        if (input.subjects.length) {
            await tx.classSubject.createMany({
                data: input.subjects.map((s, i) => ({ tenantId, ...where, subjectId: s.subjectId, isOptional: s.isOptional, sortOrder: (i + 1) * 10 })),
            });
        }
    });

    const label = (s: { subjectId: string; isOptional: boolean }) => `${nameOf.get(s.subjectId) ?? s.subjectId}${s.isOptional ? ' (optional)' : ''}`;
    const beforeNames = new Set(before.map(label));
    const afterNames = new Set(input.subjects.map(label));
    const added = [...afterNames].filter((x) => !beforeNames.has(x));
    // Names of removed subjects may be unknown here (not in this request), so look them up.
    const removedRows = before.filter((b) => !input.subjects.some((s) => s.subjectId === b.subjectId && s.isOptional === b.isOptional));
    if (removedRows.length) {
        for (const s of await db.subject.findMany({ where: { id: { in: removedRows.map((r) => r.subjectId) } }, select: { id: true, name: true } })) nameOf.set(s.id, s.name);
    }
    const removed = removedRows.map(label);
    if (added.length || removed.length) {
        await recordAudit({ action: 'subjects_change', entity: 'class', entityId: input.classId, changes: { year: year.name, ...(input.streamId ? { stream: input.streamId } : {}), added, removed } });
    }
    return getClassSubjects(input.academicYearId, input.classId);
};
