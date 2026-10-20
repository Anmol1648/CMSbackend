import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound, validationError } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { ACADEMIC, yearName } from './academic.settings';

/** Academic years (sessions). Dates are calendar days: "2026-04-01" in and out. */

export const day = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

const dateString = z.iso.date('must be a date like 2026-04-01');

export const yearInputSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(40, 'must be at most 40 characters'),
    startDate: dateString,
    endDate: dateString,
    isCurrent: z.boolean().optional(),
    /** Copy sections and class subjects from this year (new years only). */
    copyFromYearId: z.uuid().optional(),
});
export const yearUpdateSchema = yearInputSchema.omit({ isCurrent: true, copyFromYearId: true }).partial();

export const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

type YearRow = Prisma.AcademicYearGetPayload<{ include: { _count: { select: { sections: true; classSubjects: true } } } }>;

const present = (y: YearRow) => ({
    id: y.id,
    name: y.name,
    startDate: day(y.startDate),
    endDate: day(y.endDate),
    isCurrent: y.isCurrent,
    status: y.status,
    sections: y._count.sections,
    classSubjects: y._count.classSubjects,
    updatedAt: y.updatedAt,
});

const withCounts = { _count: { select: { sections: true, classSubjects: true } } } as const;

export const listYears = async () => (await db.academicYear.findMany({ include: withCounts, orderBy: { startDate: 'desc' } })).map(present);

export const yearOptions = () => db.academicYear.findMany({ select: { id: true, name: true, isCurrent: true, status: true }, orderBy: { startDate: 'desc' } });

export const getYear = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Academic year not found');
    const y = await db.academicYear.findUnique({ where: { id }, include: withCounts });
    if (!y) throw notFound('Academic year not found');
    return present(y);
};

/** The current year, if one is marked (other modules use this as their default). */
export const currentYear = () => db.academicYear.findFirst({ where: { isCurrent: true } });

/** A closed year's sections and subjects can't change. */
export const assertYearOpen = async (yearId: string, client: typeof db | Tx = db) => {
    const y = await client.academicYear.findUnique({ where: { id: yearId }, select: { name: true, status: true } });
    if (!y) throw badRequest('Academic year not found', [{ field: 'academicYearId', message: 'is not an academic year' }]);
    if (y.status === 'closed') throw conflict(`${y.name} is closed. Reopen it to make changes.`);
    return y;
};

/** What a new year should probably be: right after the latest one, or this year from the start month. */
export const suggestYear = async () => {
    const s = await getSettings({ month: ACADEMIC.yearStartMonth, format: ACADEMIC.yearNameFormat });
    const latest = await db.academicYear.findFirst({ orderBy: { endDate: 'desc' }, select: { endDate: true } });
    let start: Date;
    if (latest) {
        start = new Date(latest.endDate.getTime() + 86_400_000);
    } else {
        const now = new Date();
        const month = Number(s.month) - 1;
        const year = now.getUTCMonth() >= month ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
        start = new Date(Date.UTC(year, month, 1));
    }
    const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()) - 86_400_000);
    return { name: yearName(start.getUTCFullYear(), s.format), startDate: day(start), endDate: day(end) };
};

const checkDates = async (name: string, startDate: string, endDate: string, exceptId?: string) => {
    if (endDate <= startDate) throw badRequest('The year must end after it starts', [{ field: 'endDate', message: 'must be after the start date' }]);
    const days = (toDate(endDate).getTime() - toDate(startDate).getTime()) / 86_400_000;
    if (days > 550) throw badRequest('An academic year can be at most 18 months long', [{ field: 'endDate', message: 'is too far after the start date' }]);
    const except = exceptId ? { id: { not: exceptId } } : {};
    const sameName = await db.academicYear.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...except }, select: { id: true } });
    if (sameName) throw conflict(`There is already an academic year called ${name}`);
    const overlap = await db.academicYear.findFirst({
        where: { startDate: { lte: toDate(endDate) }, endDate: { gte: toDate(startDate) }, ...except },
        select: { name: true },
    });
    if (overlap) throw conflict(`These dates overlap ${overlap.name}`);
};

export const createYear = async (input: z.infer<typeof yearInputSchema>) => {
    await checkDates(input.name, input.startDate, input.endDate);
    if (input.copyFromYearId) await getYear(input.copyFromYearId);
    const tenantId = getTenantId()!;
    const first = !(await db.academicYear.count());
    const created = await withTransaction(async (tx) => {
        const makeCurrent = input.isCurrent ?? first;
        if (makeCurrent) await tx.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
        return tx.academicYear.create({ data: { tenantId, name: input.name, startDate: toDate(input.startDate), endDate: toDate(input.endDate), isCurrent: makeCurrent } });
    });
    if (input.copyFromYearId) await copyStructure(created.id, input.copyFromYearId, { sections: true, subjects: true });
    return getYear(created.id);
};

export const updateYear = async (id: string, input: z.infer<typeof yearUpdateSchema>) => {
    const current = await getYear(id);
    const merged = { name: input.name ?? current.name, startDate: input.startDate ?? current.startDate, endDate: input.endDate ?? current.endDate };
    await checkDates(merged.name, merged.startDate, merged.endDate, id);
    await db.academicYear.update({ where: { id }, data: { name: merged.name, startDate: toDate(merged.startDate), endDate: toDate(merged.endDate) } });
    return getYear(id);
};

/** Makes this the current year (the one every screen opens on). */
export const setCurrentYear = async (id: string) => {
    const y = await getYear(id);
    if (y.status === 'closed') throw conflict(`${y.name} is closed. Reopen it before making it the current year.`);
    await withTransaction(async (tx) => {
        await tx.academicYear.updateMany({ where: { isCurrent: true, id: { not: id } }, data: { isCurrent: false } });
        await tx.academicYear.update({ where: { id }, data: { isCurrent: true } });
    });
    return getYear(id);
};

export const setYearStatus = async (id: string, status: 'open' | 'closed') => {
    const y = await getYear(id);
    if (status === 'closed' && y.isCurrent) throw conflict(`${y.name} is the current year. Make another year current before closing it.`);
    await db.academicYear.update({ where: { id }, data: { status } });
    return getYear(id);
};

/** Only an empty year can be deleted (no sections, no subjects). */
export const deleteYear = async (id: string) => {
    const y = await getYear(id);
    if (y.isCurrent) throw conflict(`${y.name} is the current year and can't be deleted`);
    if (y.sections || y.classSubjects) throw conflict(`${y.name} has sections or subjects set up. Remove those first, or close the year instead.`);
    await db.academicYear.delete({ where: { id } });
    return { id, deleted: true };
};

/**
 * Copies the set-up of one year into another: sections (with stream, capacity, room and class
 * teacher) and subjects per class. Classes that already have sections / subjects in the target
 * year are left as they are.
 */
export const copyStructure = async (targetId: string, fromId: string, what: { sections: boolean; subjects: boolean }) => {
    if (targetId === fromId) throw badRequest('Choose a different year to copy from');
    await getYear(fromId);
    await assertYearOpen(targetId);
    const tenantId = getTenantId()!;
    const result = { sections: 0, subjects: 0 };

    if (what.sections) {
        const [from, existing] = await Promise.all([
            db.section.findMany({ where: { academicYearId: fromId, isActive: true }, include: { classTeacher: { select: { status: true } } } }),
            db.section.findMany({ where: { academicYearId: targetId }, select: { classId: true } }),
        ]);
        const skip = new Set(existing.map((s) => s.classId));
        const rows = from.filter((s) => !skip.has(s.classId));
        if (rows.length) {
            const r = await db.section.createMany({
                data: rows.map((s) => ({
                    tenantId,
                    academicYearId: targetId,
                    classId: s.classId,
                    name: s.name,
                    streamId: s.streamId,
                    capacity: s.capacity,
                    room: s.room,
                    // A teacher who has left isn't copied.
                    classTeacherId: s.classTeacher && s.classTeacher.status === 'working' ? s.classTeacherId : null,
                    sortOrder: s.sortOrder,
                })),
                skipDuplicates: true,
            });
            result.sections = r.count;
        }
    }
    if (what.subjects) {
        const [from, existing] = await Promise.all([
            db.classSubject.findMany({ where: { academicYearId: fromId, subject: { isActive: true } } }),
            db.classSubject.findMany({ where: { academicYearId: targetId }, select: { classId: true } }),
        ]);
        const skip = new Set(existing.map((s) => s.classId));
        const rows = from.filter((s) => !skip.has(s.classId));
        if (rows.length) {
            const r = await db.classSubject.createMany({
                data: rows.map((s) => ({ tenantId, academicYearId: targetId, classId: s.classId, streamId: s.streamId, subjectId: s.subjectId, isOptional: s.isOptional, sortOrder: s.sortOrder })),
                skipDuplicates: true,
            });
            result.subjects = r.count;
        }
    }
    await recordAudit({ action: 'copy', entity: 'academic_year', entityId: targetId, changes: { from: fromId, sections: result.sections, subjects: result.subjects } });
    return result;
};
