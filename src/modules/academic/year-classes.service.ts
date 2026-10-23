import { z } from 'zod';
import { db, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { assertYearOpen, currentYear } from './years.service';

/**
 * The classes a session runs. The class list (Academic → Classes) is the school's catalogue; each
 * session picks the classes it runs from it, with whether admissions are open and the seats. Every
 * class dropdown of a session shows only these, so stopping Bal Vatika next year leaves this year
 * (and its students, fees and attendance) as it is.
 */

const uuidOk = (id: string) => z.uuid().safeParse(id).success;

/** The classes running in a session (the current one by default), in order. */
export const classesOfYear = async (yearId?: string | null, opts: { admissionsOpen?: boolean } = {}) => {
    const id = yearId && uuidOk(yearId) ? yearId : (await currentYear())?.id;
    if (!id) return [];
    const rows = await db.yearClass.findMany({
        where: { academicYearId: id, schoolClass: { isActive: true }, ...(opts.admissionsOpen ? { admissionsOpen: true } : {}) },
        select: { admissionsOpen: true, seats: true, schoolClass: { select: { id: true, name: true, shortName: true, hasStreams: true, sortOrder: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { schoolClass: { name: 'asc' } }],
    });
    return rows.map((r) => ({ ...r.schoolClass, admissionsOpen: r.admissionsOpen, seats: r.seats }));
};

/** Is the class running in the session. */
export const runsIn = async (yearId: string, classId: string) => !!(await db.yearClass.findFirst({ where: { academicYearId: yearId, classId }, select: { id: true } }));

/** Adds a class to a session if it isn't there yet (e.g. a section is added for it). */
export const ensureInYear = async (yearId: string, classId: string, client: typeof db | Tx = db) => {
    await client.yearClass.upsert({ where: { academicYearId_classId: { academicYearId: yearId, classId } }, create: { tenantId: getTenantId()!, academicYearId: yearId, classId }, update: {} });
};

/** What a session's classes use (a class in use can't be taken off the session). */
const usageOf = async (yearId: string) => {
    const [sections, students, fees, loads, enquiries, subjects] = await Promise.all([
        db.section.groupBy({ by: ['classId'], where: { academicYearId: yearId }, _count: { _all: true } }),
        db.enrolment.findMany({ where: { academicYearId: yearId }, select: { section: { select: { classId: true } } } }),
        db.feeStructureLine.groupBy({ by: ['classId'], where: { academicYearId: yearId }, _count: { _all: true } }),
        db.ttLoad.groupBy({ by: ['classId'], where: { academicYearId: yearId }, _count: { _all: true } }),
        db.enquiry.groupBy({ by: ['classId'], where: { academicYearId: yearId }, _count: { _all: true } }),
        db.classSubject.groupBy({ by: ['classId'], where: { academicYearId: yearId }, _count: { _all: true } }),
    ]);
    const count = (rows: { classId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.classId, r._count._all]));
    const studentsOf = new Map<string, number>();
    for (const e of students) studentsOf.set(e.section.classId, (studentsOf.get(e.section.classId) ?? 0) + 1);
    return { sections: count(sections), students: studentsOf, fees: count(fees), loads: count(loads), enquiries: count(enquiries), subjects: count(subjects) };
};

/** Every class of the catalogue against a session: running or not, admissions, seats, and what uses it. */
export const yearClassesOverview = async (yearId: string) => {
    if (!uuidOk(yearId)) throw notFound('Academic year not found');
    const year = await db.academicYear.findUnique({ where: { id: yearId }, select: { id: true, name: true, status: true } });
    if (!year) throw notFound('Academic year not found');
    const [classes, inYear, use] = await Promise.all([
        db.schoolClass.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, shortName: true, isActive: true } }),
        db.yearClass.findMany({ where: { academicYearId: yearId } }),
        usageOf(yearId),
    ]);
    const by = new Map(inYear.map((y) => [y.classId, y]));
    return {
        year,
        classes: classes
            .filter((c) => c.isActive || by.has(c.id))
            .map((c) => {
                const y = by.get(c.id);
                const used = { sections: use.sections.get(c.id) ?? 0, students: use.students.get(c.id) ?? 0, fees: use.fees.get(c.id) ?? 0, timetable: use.loads.get(c.id) ?? 0, enquiries: use.enquiries.get(c.id) ?? 0, subjects: use.subjects.get(c.id) ?? 0 };
                return { id: c.id, name: c.name, shortName: c.shortName, classActive: c.isActive, runs: !!y, admissionsOpen: y?.admissionsOpen ?? true, seats: y?.seats ?? null, used, seatsLeft: y?.seats != null ? y.seats - used.students : null };
            }),
    };
};

export const yearClassesSchema = z.strictObject({
    classes: z
        .array(z.strictObject({ classId: z.uuid(), admissionsOpen: z.boolean().default(true), seats: z.number().int().min(0).max(5000).nullable().default(null) }))
        .max(100)
        .refine((xs) => new Set(xs.map((x) => x.classId)).size === xs.length, 'a class is there twice'),
});

/** Sets the classes a session runs. A class still in use there (sections, fees…) can't be taken off. */
export const setYearClasses = async (yearId: string, input: z.infer<typeof yearClassesSchema>) => {
    const o = await yearClassesOverview(yearId);
    await assertYearOpen(yearId);
    const wanted = new Map(input.classes.map((c) => [c.classId, c]));
    const known = new Set(o.classes.map((c) => c.id));
    const unknown = input.classes.find((c) => !known.has(c.classId));
    if (unknown) throw badRequest('Choose classes from the class list');
    const removing = o.classes.filter((c) => c.runs && !wanted.has(c.id));
    const blocked = removing.filter((c) => c.used.sections || c.used.students || c.used.fees || c.used.timetable || c.used.enquiries);
    if (blocked.length) {
        const what = (c: (typeof blocked)[number]) =>
            [c.used.students && `${c.used.students} students`, c.used.sections && `${c.used.sections} sections`, c.used.fees && 'a fee structure', c.used.timetable && 'timetable periods', c.used.enquiries && `${c.used.enquiries} enquiries`].filter(Boolean).join(', ');
        throw conflict(`${blocked.map((c) => `${c.name} (${what(c)})`).join('; ')} ${blocked.length === 1 ? 'is' : 'are'} in use in ${o.year.name}. Remove those first to take ${blocked.length === 1 ? 'it' : 'them'} off the session.`);
    }
    const tenantId = getTenantId()!;
    await db.$transaction([
        db.yearClass.deleteMany({ where: { academicYearId: yearId, classId: { in: removing.map((c) => c.id) } } }),
        // Class subjects of a class taken off go with it (nothing else uses them).
        db.classSubject.deleteMany({ where: { academicYearId: yearId, classId: { in: removing.map((c) => c.id) } } }),
        ...input.classes.map((c) =>
            db.yearClass.upsert({
                where: { academicYearId_classId: { academicYearId: yearId, classId: c.classId } },
                create: { tenantId, academicYearId: yearId, classId: c.classId, admissionsOpen: c.admissionsOpen, seats: c.seats },
                update: { admissionsOpen: c.admissionsOpen, seats: c.seats },
            })
        ),
    ]);
    await recordAudit({ action: 'session_classes_set', entity: 'academic_year', entityId: yearId, changes: { year: o.year.name, classes: input.classes.length, removed: removing.map((c) => c.name) } });
    return yearClassesOverview(yearId);
};
