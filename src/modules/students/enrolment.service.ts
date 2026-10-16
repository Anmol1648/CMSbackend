import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { assertYearOpen } from '../academic/years.service';
import { STUDENTS } from './students.settings';

/** A student's place in a year: section, roll number, house and chosen optional subjects. */

export const enrolmentSchema = z.strictObject({
    academicYearId: z.uuid('choose an academic year'),
    sectionId: z.uuid('choose a section'),
    rollNumber: z.number().int('must be a whole number').min(1, 'must be at least 1').max(9999).nullable().optional(),
    houseId: z.uuid('choose a house').nullable().optional(),
    optionalSubjectIds: z.array(z.uuid()).max(20).optional(),
});
export type EnrolmentInput = z.infer<typeof enrolmentSchema>;

type Client = typeof db | Tx;

/** Checks a placement; returns the section with its class and how full it is. */
export const checkPlacement = async (input: EnrolmentInput, studentId: string | null, client: Client = db) => {
    await assertYearOpen(input.academicYearId, client);
    const section = await client.section.findUnique({
        where: { id: input.sectionId },
        include: { schoolClass: { select: { id: true, name: true, shortName: true } }, stream: { select: { id: true, name: true } } },
    });
    if (!section || section.academicYearId !== input.academicYearId) throw badRequest('Choose a section of that academic year', [{ field: 'sectionId', message: 'is not a section of this year' }]);
    if (!section.isActive) throw badRequest(`${section.schoolClass.name} ${section.name} is inactive`, [{ field: 'sectionId', message: 'is inactive' }]);

    const s = await getSettings({ capacity: STUDENTS.capacityCheck });
    let warning: string | null = null;
    if (section.capacity && s.capacity !== 'off') {
        const count = await client.enrolment.count({ where: { sectionId: section.id, ...(studentId ? { studentId: { not: studentId } } : {}), student: { status: 'active' } } });
        if (count >= section.capacity) {
            const message = `${section.schoolClass.shortName ?? section.schoolClass.name}-${section.name} is full (${count} of ${section.capacity})`;
            if (s.capacity === 'block') throw conflict(`${message}. Choose another section or raise its capacity.`);
            warning = message;
        }
    }
    if (input.houseId && !(await client.masterValue.findFirst({ where: { id: input.houseId, master: 'house' } }))) {
        throw badRequest('Choose a house from the list', [{ field: 'houseId', message: 'is not a house' }]);
    }
    if (input.optionalSubjectIds?.length) {
        const allowed = await client.classSubject.findMany({
            where: { academicYearId: input.academicYearId, classId: section.classId, isOptional: true, OR: [{ streamId: null }, ...(section.streamId ? [{ streamId: section.streamId }] : [])] },
            select: { subjectId: true },
        });
        const ok = new Set(allowed.map((a) => a.subjectId));
        if (input.optionalSubjectIds.some((id) => !ok.has(id))) {
            throw badRequest(`Choose optional subjects of ${section.schoolClass.name}`, [{ field: 'optionalSubjectIds', message: 'contains a subject that is not optional for this class' }]);
        }
    }
    if (input.rollNumber) {
        const taken = await client.enrolment.findFirst({ where: { sectionId: section.id, rollNumber: input.rollNumber, ...(studentId ? { studentId: { not: studentId } } : {}) }, select: { student: { select: { firstName: true, lastName: true } } } });
        if (taken) throw conflict(`Roll number ${input.rollNumber} is already ${[taken.student.firstName, taken.student.lastName].filter(Boolean).join(' ')}'s`);
    }
    return { section, warning };
};

/** The next free roll number of a section. */
const nextRoll = async (sectionId: string, client: Client) => ((await client.enrolment.aggregate({ where: { sectionId }, _max: { rollNumber: true } }))._max.rollNumber ?? 0) + 1;

/** Places (or moves) a student in a year. Inside a transaction when `client` is one. */
export const saveEnrolment = async (studentId: string, input: EnrolmentInput, client: Client = db) => {
    const { section, warning } = await checkPlacement(input, studentId, client);
    const s = await getSettings({ onJoin: STUDENTS.rollOnJoin });
    const existing = await client.enrolment.findUnique({ where: { studentId_academicYearId: { studentId, academicYearId: input.academicYearId } } });
    const moved = !existing || existing.sectionId !== section.id;
    // A roll typed by hand wins; otherwise a student who joins (or moves to) a section gets one by the setting.
    const rollNumber = input.rollNumber !== undefined ? input.rollNumber : moved ? (s.onJoin === 'blank' ? null : await nextRoll(section.id, client)) : existing!.rollNumber;
    const data = {
        sectionId: section.id,
        rollNumber,
        houseId: input.houseId === undefined ? existing?.houseId ?? null : input.houseId,
        optionalSubjectIds: input.optionalSubjectIds ?? (moved ? [] : existing!.optionalSubjectIds),
    };
    const enrolment = existing
        ? await client.enrolment.update({ where: { id: existing.id }, data })
        : await client.enrolment.create({ data: { tenantId: getTenantId()!, studentId, academicYearId: input.academicYearId, ...data } });
    return { enrolment, section, warning, renumber: moved && input.rollNumber === undefined && s.onJoin === 'renumber' };
};

export const placeStudent = async (studentId: string, input: EnrolmentInput) => {
    if (!(await db.student.findUnique({ where: { id: studentId }, select: { id: true } }))) throw notFound('Student not found');
    const before = await db.enrolment.findUnique({ where: { studentId_academicYearId: { studentId, academicYearId: input.academicYearId } }, include: { section: { include: { schoolClass: true } } } });
    const result = await withTransaction((tx) => saveEnrolment(studentId, input, tx));
    if (result.renumber) await renumberSection(result.section.id);
    const label = (s: { name: string; schoolClass: { name: string } }) => `${s.schoolClass.name} ${s.name}`;
    await recordAudit({
        action: before ? 'section_change' : 'placed',
        entity: 'student',
        entityId: studentId,
        changes: { section: [before ? label(before.section) : null, label(result.section)] },
    });
    return { warning: result.warning };
};

/** What the roll-number order looks at. */
export interface RollKey {
    firstName: string;
    lastName: string | null;
    admissionNo: string;
    admissionDate: Date;
    girl: boolean;
}

const NAME = (st: { firstName: string; lastName: string | null }) => `${st.firstName} ${st.lastName ?? ''}`.trim().toLowerCase();
const byName = (a: RollKey, b: RollKey) => NAME(a).localeCompare(NAME(b));

/** Sorts students by a roll-number order (System Settings → Students). */
export const ROLL_ORDERS: Record<string, (a: RollKey, b: RollKey) => number> = {
    first_name: byName,
    last_name: (a, b) => (a.lastName ?? '').localeCompare(b.lastName ?? '') || byName(a, b),
    admission_number: (a, b) => a.admissionNo.localeCompare(b.admissionNo, undefined, { numeric: true }),
    admission_date: (a, b) => a.admissionDate.getTime() - b.admissionDate.getTime() || byName(a, b),
    girls_first: (a, b) => Number(b.girl) - Number(a.girl) || byName(a, b),
    boys_first: (a, b) => Number(a.girl) - Number(b.girl) || byName(a, b),
};

export const isGirl = (g: { code: string | null; name: string } | null) => !!g && (g.code === 'F' || /female|girl/i.test(g.name));

/** Gives the active students of a section roll numbers 1, 2, 3… in the school's order. */
export const renumberSection = async (sectionId: string) => {
    const s = await getSettings({ order: STUDENTS.rollOrder });
    if (s.order === 'manual') throw badRequest('Roll numbers are typed by hand (System Settings → Students)');
    const section = await db.section.findUnique({ where: { id: sectionId }, select: { academicYearId: true, name: true, schoolClass: { select: { name: true } } } });
    if (!section) throw notFound('Section not found');
    await assertYearOpen(section.academicYearId);
    const rows = await db.enrolment.findMany({
        where: { sectionId, student: { status: 'active' } },
        select: { id: true, student: { select: { firstName: true, lastName: true, admissionNo: true, admissionDate: true, gender: { select: { code: true, name: true } } } } },
    });
    const key = (r: (typeof rows)[number]): RollKey => ({ ...r.student, girl: isGirl(r.student.gender) });
    rows.sort((a, b) => ROLL_ORDERS[s.order](key(a), key(b)));
    await withTransaction(async (tx) => {
        // Clear first: roll numbers are unique per section, and the new order may swap them.
        await tx.enrolment.updateMany({ where: { sectionId }, data: { rollNumber: null } }); // students who left lose theirs too
        for (const [i, r] of rows.entries()) await tx.enrolment.update({ where: { id: r.id }, data: { rollNumber: i + 1 } });
    }, { timeout: 60_000 });
    await recordAudit({ action: 'renumber', entity: 'section', entityId: sectionId, changes: { order: s.order, students: rows.length } });
    return { section: `${section.schoolClass.name} ${section.name}`, students: rows.length };
};
