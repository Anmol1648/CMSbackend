import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSetting } from '../../core/settings';
import { cleanName } from '../masters/masters.service';
import { ACADEMIC } from './academic.settings';
import { assertYearOpen } from './years.service';

/** Classes (the same every year) and their sections (per year). */

// ─── Things that point at sections (students, timetables…) ───────────────────

export interface SectionUsage {
    /** Plural, e.g. "students". */
    label: string;
    count: (sectionId: string) => Promise<number>;
}
const sectionUsages: SectionUsage[] = [];
/** Modules that keep records per section call this, so a section in use can't be deleted. */
export const registerSectionUsage = (usage: SectionUsage) => sectionUsages.push(usage);

const uuid = (label: string) => z.uuid(`choose a ${label}`);
const optionalText = (max: number) =>
    z
        .union([z.literal('').transform(() => null), z.string().trim().max(max, `must be at most ${max} characters`), z.null()])
        .optional();

// ─── Classes ─────────────────────────────────────────────────────────────────

export const classInputSchema = z.strictObject({
    name: z.string().transform(cleanName).pipe(z.string().min(1, 'is required').max(60, 'must be at most 60 characters')),
    shortName: optionalText(12),
    groupId: uuid('class group').nullable().optional(),
    hasStreams: z.boolean().optional(),
    isActive: z.boolean().optional(),
});
export const classUpdateSchema = classInputSchema.partial();

const sectionInclude = {
    stream: { select: { id: true, name: true } },
    classTeacher: { select: { id: true, displayName: true, username: true } },
} as const;
type SectionRow = Prisma.SectionGetPayload<{ include: typeof sectionInclude }>;

const presentSection = (s: SectionRow) => ({
    id: s.id,
    academicYearId: s.academicYearId,
    classId: s.classId,
    name: s.name,
    stream: s.stream,
    capacity: s.capacity,
    room: s.room,
    classTeacher: s.classTeacher,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
});

/** Every class in order, with its sections in the given year. */
export const listClasses = async (yearId?: string) => {
    const classes = await db.schoolClass.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
            group: { select: { id: true, name: true } },
            ...(yearId ? { sections: { where: { academicYearId: yearId }, include: sectionInclude, orderBy: [{ sortOrder: 'asc' as const }, { name: 'asc' as const }] } } : {}),
        },
    });
    return classes.map(({ sections, ...c }) => ({
        id: c.id,
        name: c.name,
        shortName: c.shortName,
        group: c.group,
        hasStreams: c.hasStreams,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        sections: (sections as SectionRow[] | undefined)?.map(presentSection) ?? [],
    }));
};

export const classOptions = () =>
    db.schoolClass.findMany({ where: { isActive: true }, select: { id: true, name: true, shortName: true, hasStreams: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });

const getClass = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Class not found');
    const c = await db.schoolClass.findUnique({ where: { id } });
    if (!c) throw notFound('Class not found');
    return c;
};

const checkClass = async (input: { name: string; shortName?: string | null; groupId?: string | null }, exceptId?: string) => {
    const except = exceptId ? { id: { not: exceptId } } : {};
    if (await db.schoolClass.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, ...except } })) throw conflict(`There is already a class called ${input.name}`);
    if (input.shortName && (await db.schoolClass.findFirst({ where: { shortName: { equals: input.shortName, mode: 'insensitive' }, ...except } }))) {
        throw conflict(`The short name ${input.shortName} is already used by another class`);
    }
    if (input.groupId && !(await db.masterValue.findFirst({ where: { id: input.groupId, master: 'class_group' } }))) {
        throw badRequest('Choose a class group from the list', [{ field: 'groupId', message: 'is not a class group' }]);
    }
};

export const createClass = async (input: z.infer<typeof classInputSchema>) => {
    await checkClass(input);
    const last = await db.schoolClass.aggregate({ _max: { sortOrder: true } });
    const c = await db.schoolClass.create({
        data: {
            tenantId: getTenantId()!,
            name: input.name,
            shortName: input.shortName ?? null,
            groupId: input.groupId ?? null,
            hasStreams: input.hasStreams ?? false,
            isActive: input.isActive ?? true,
            sortOrder: (last._max.sortOrder ?? 0) + 10,
        },
    });
    return (await listClasses()).find((x) => x.id === c.id)!;
};

export const updateClass = async (id: string, input: z.infer<typeof classUpdateSchema>) => {
    const current = await getClass(id);
    const merged = { name: input.name ?? current.name, shortName: input.shortName === undefined ? current.shortName : input.shortName, groupId: input.groupId === undefined ? current.groupId : input.groupId };
    await checkClass(merged, id);
    if (input.hasStreams === false && current.hasStreams) {
        const withStream = await db.section.count({ where: { classId: id, streamId: { not: null } } });
        const subjects = await db.classSubject.count({ where: { classId: id, streamId: { not: null } } });
        if (withStream || subjects) throw conflict(`${current.name} has sections or subjects set for a stream. Change those first.`);
    }
    await db.schoolClass.update({ where: { id }, data: { ...merged, ...(input.hasStreams !== undefined ? { hasStreams: input.hasStreams } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) } });
    return (await listClasses()).find((x) => x.id === id)!;
};

export const deleteClass = async (id: string) => {
    const c = await getClass(id);
    const [sections, subjects] = await Promise.all([db.section.count({ where: { classId: id } }), db.classSubject.count({ where: { classId: id } })]);
    if (sections || subjects) throw conflict(`${c.name} has sections or subjects (in this or an earlier year). Make it inactive instead.`);
    await db.schoolClass.delete({ where: { id } });
    return { id, deleted: true };
};

/** Swaps an item with its neighbour and renumbers 10, 20, 30… (only rows whose place changed are written). */
const reorder = async <T extends { id: string; sortOrder: number }>(rows: T[], id: string, direction: 'up' | 'down', save: (id: string, sortOrder: number) => Promise<unknown>) => {
    const i = rows.findIndex((r) => r.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    for (const [n, r] of rows.entries()) if (r.sortOrder !== (n + 1) * 10) await save(r.id, (n + 1) * 10);
};

export const moveClass = async (id: string, direction: 'up' | 'down') => {
    await getClass(id);
    await withTransaction(async (tx) => {
        const rows = await tx.schoolClass.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, sortOrder: true } });
        await reorder(rows, id, direction, (rid, sortOrder) => tx.schoolClass.update({ where: { id: rid }, data: { sortOrder } }));
    });
    return listClasses();
};

// ─── Sections ────────────────────────────────────────────────────────────────

export const sectionInputSchema = z.strictObject({
    academicYearId: uuid('academic year'),
    classId: uuid('class'),
    name: z.string().transform(cleanName).pipe(z.string().min(1, 'is required').max(20, 'must be at most 20 characters')),
    streamId: uuid('stream').nullable().optional(),
    capacity: z.number().int('must be a whole number').min(1, 'must be at least 1').max(500, 'must be at most 500').nullable().optional(),
    room: optionalText(40),
    classTeacherId: uuid('teacher').nullable().optional(),
    isActive: z.boolean().optional(),
});
export const sectionUpdateSchema = sectionInputSchema.omit({ academicYearId: true, classId: true }).partial();

export const getSection = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Section not found');
    const s = await db.section.findUnique({ where: { id }, include: sectionInclude });
    if (!s) throw notFound('Section not found');
    return presentSection(s);
};

/** Staff and administrators who can be class teachers. */
export const teacherOptions = () =>
    db.user.findMany({ where: { status: 'active', kind: { in: ['staff', 'admin'] } }, select: { id: true, displayName: true, username: true }, orderBy: { displayName: 'asc' } });

const checkSection = async (
    s: { academicYearId: string; classId: string; name: string; streamId?: string | null; classTeacherId?: string | null },
    exceptId?: string
) => {
    await assertYearOpen(s.academicYearId);
    const cls = await db.schoolClass.findUnique({ where: { id: s.classId }, select: { name: true, hasStreams: true } });
    if (!cls) throw badRequest('Choose a class', [{ field: 'classId', message: 'is not a class' }]);
    if (cls.hasStreams && !s.streamId) throw badRequest(`Choose the stream for this ${cls.name} section`, [{ field: 'streamId', message: 'choose a stream' }]);
    if (!cls.hasStreams && s.streamId) throw badRequest(`${cls.name} has no streams`, [{ field: 'streamId', message: 'this class has no streams' }]);
    if (s.streamId && !(await db.masterValue.findFirst({ where: { id: s.streamId, master: 'stream' } }))) throw badRequest('Choose a stream from the list', [{ field: 'streamId', message: 'is not a stream' }]);

    const except = exceptId ? { id: { not: exceptId } } : {};
    const same = await db.section.findFirst({ where: { academicYearId: s.academicYearId, classId: s.classId, name: { equals: s.name, mode: 'insensitive' }, ...except } });
    if (same) throw conflict(`${cls.name} already has a section ${s.name} this year`);

    if (s.classTeacherId) {
        const teacher = await db.user.findFirst({ where: { id: s.classTeacherId, status: 'active', kind: { in: ['staff', 'admin'] } }, select: { displayName: true } });
        if (!teacher) throw badRequest('Choose an active staff member as class teacher', [{ field: 'classTeacherId', message: 'is not an active staff member' }]);
        if (await getSetting(ACADEMIC.oneSectionPerClassTeacher)) {
            const other = await db.section.findFirst({
                where: { academicYearId: s.academicYearId, classTeacherId: s.classTeacherId, ...except },
                select: { name: true, schoolClass: { select: { name: true } } },
            });
            if (other) throw conflict(`${teacher.displayName} is already class teacher of ${other.schoolClass.name} ${other.name} this year`);
        }
    }
};

export const createSection = async (input: z.infer<typeof sectionInputSchema>) => {
    await checkSection(input);
    const last = await db.section.aggregate({ where: { academicYearId: input.academicYearId, classId: input.classId }, _max: { sortOrder: true } });
    const s = await db.section.create({
        data: {
            tenantId: getTenantId()!,
            academicYearId: input.academicYearId,
            classId: input.classId,
            name: input.name,
            streamId: input.streamId ?? null,
            capacity: input.capacity ?? null,
            room: input.room ?? null,
            classTeacherId: input.classTeacherId ?? null,
            isActive: input.isActive ?? true,
            sortOrder: (last._max.sortOrder ?? 0) + 10,
        },
    });
    return getSection(s.id);
};

export const updateSection = async (id: string, input: z.infer<typeof sectionUpdateSchema>) => {
    const current = await db.section.findUnique({ where: { id } });
    if (!current) throw notFound('Section not found');
    const merged = {
        academicYearId: current.academicYearId,
        classId: current.classId,
        name: input.name ?? current.name,
        streamId: input.streamId === undefined ? current.streamId : input.streamId,
        classTeacherId: input.classTeacherId === undefined ? current.classTeacherId : input.classTeacherId,
    };
    await checkSection(merged, id);
    await db.section.update({
        where: { id },
        data: {
            name: merged.name,
            streamId: merged.streamId ?? null,
            classTeacherId: merged.classTeacherId ?? null,
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
            ...(input.room !== undefined ? { room: input.room } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
    });
    return getSection(id);
};

export const deleteSection = async (id: string) => {
    const s = await getSection(id);
    await assertYearOpen(s.academicYearId);
    for (const usage of sectionUsages) {
        const n = await usage.count(id);
        if (n) throw conflict(`Section ${s.name} has ${n} ${usage.label}. Make it inactive instead.`);
    }
    await db.section.delete({ where: { id } });
    return { id, deleted: true };
};

export const moveSection = async (id: string, direction: 'up' | 'down') => {
    const s = await getSection(id);
    await withTransaction(async (tx) => {
        const rows = await tx.section.findMany({ where: { academicYearId: s.academicYearId, classId: s.classId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, sortOrder: true } });
        await reorder(rows, id, direction, (rid, sortOrder) => tx.section.update({ where: { id: rid }, data: { sortOrder } }));
    });
    return getSection(id);
};

/** Sections for dropdowns: "VI-A", "XI-A (Science)". */
export const sectionOptions = async (yearId: string, classId?: string) => {
    const rows = await db.section.findMany({
        where: { academicYearId: yearId, isActive: true, ...(classId ? { classId } : {}) },
        select: { id: true, name: true, classId: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } }, stream: { select: { name: true } } },
    });
    return rows
        .sort((a, b) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.name.localeCompare(b.name))
        .map((r) => ({
            id: r.id,
            name: r.name,
            classId: r.classId,
            label: `${r.schoolClass.shortName ?? r.schoolClass.name}-${r.name}${r.stream ? ` (${r.stream.name})` : ''}`,
        }));
};
