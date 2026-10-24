import { z } from 'zod';
import { db } from '../../core/db';
import { notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { isoOf, todayIST } from '../attendance/attendance.settings';
import { computeDues, dueStudents } from '../fees/dues.service';
import { LIBRARY } from './library.settings';

/**
 * Library members: every active student and working staff member (no sign-up). Their limits come
 * from Masters → Library member types (a student's by their class).
 */

export type MemberKind = 'student' | 'staff';
export interface MemberRef {
    memberKind: string;
    studentId: string | null;
    staffId: string | null;
}
export const memberId = (r: MemberRef) => (r.memberKind === 'staff' ? r.staffId : r.studentId) ?? '';

export interface Limits {
    type: string;
    books: number;
    days: number;
    renewals: number;
}

/** A member's limits: the first member type for them (students: one that lists their class, else one with no classes). */
export const limitsFor = async (kind: MemberKind, classShortName: string | null): Promise<Limits> => {
    const types = await db.masterValue.findMany({ where: { master: 'library_member_type', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { name: true, extra: true } });
    const list = types.map((t) => ({ name: t.name, ...((t.extra ?? {}) as { for?: string; classes?: string; books?: number; days?: number; renewals?: number }) })).filter((t) => (t.for ?? 'student') === kind);
    const cls = (classShortName ?? '').trim().toLowerCase();
    const listed = (t: (typeof list)[number]) => (t.classes ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
    const t = list.find((x) => cls && listed(x).includes(cls)) ?? list.find((x) => !listed(x).length) ?? list[0];
    return t ? { type: t.name, books: Number(t.books ?? 2), days: Number(t.days ?? 14), renewals: Number(t.renewals ?? 1) } : { type: kind === 'staff' ? 'Staff' : 'Student', books: kind === 'staff' ? 5 : 2, days: kind === 'staff' ? 30 : 14, renewals: 1 };
};

/** Names of the members on some rows (students with their class). */
export const memberNames = async (rows: MemberRef[]) => {
    const year = await currentYear();
    const sIds = [...new Set(rows.map((r) => r.studentId).filter((x): x is string => !!x))];
    const tIds = [...new Set(rows.map((r) => r.staffId).filter((x): x is string => !!x))];
    const [students, staff, enrol] = await Promise.all([
        sIds.length ? db.student.findMany({ where: { id: { in: sIds } }, select: { id: true, firstName: true, middleName: true, lastName: true } }) : [],
        tIds.length ? db.staff.findMany({ where: { id: { in: tIds } }, select: { id: true, firstName: true, middleName: true, lastName: true } }) : [],
        year && sIds.length ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: sIds } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [],
    ]);
    const out = new Map<string, string>();
    for (const s of students) {
        const e = enrol.find((x) => x.studentId === s.id);
        out.set(s.id, `${fullName(s)}${e ? ` (${sectionLabel(e.section)})` : ''}`);
    }
    for (const s of staff) out.set(s.id, `${fullName(s)} (staff)`);
    return out;
};

/** What a member owes the library: counter fines due, and fee fines not paid yet with the fees. */
export const unpaidFines = async (kind: MemberKind, id: string) => {
    const fines = await db.libraryFine.findMany({ where: kind === 'staff' ? { staffId: id } : { studentId: id }, select: { amount: true, waived: true, payAt: true, status: true } });
    const counter = fines.filter((f) => f.payAt === 'counter' && f.status === 'due').reduce((a, f) => a + f.amount - f.waived, 0);
    let fees = 0;
    if (kind === 'student' && fines.some((f) => f.payAt === 'fees')) {
        const year = await currentYear();
        const { code } = await getSettings({ code: LIBRARY.feeHeadCode });
        const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
        if (year && head) {
            const dues = await computeDues(year.id, await dueStudents(year.id, { id }));
            fees = (dues.get(id)?.instalments ?? []).flatMap((i) => i.lines).filter((l) => l.feeHeadId === head.id).reduce((a, l) => a + l.balance, 0);
        }
    }
    return { counter, fees, total: counter + fees };
};

/** A member in full, for the counter: who, their limits, books they have, reservations and fines. */
export const memberCard = async (kind: MemberKind, id: string) => {
    const year = await currentYear();
    let name = '';
    let detail = '';
    let code = '';
    let photoFileId: string | null = null;
    let cls: string | null = null;
    let active = true;
    if (kind === 'student') {
        const s = await db.student.findFirst({ where: { id }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true, status: true } });
        if (!s) throw notFound('Student not found');
        const e = year ? await db.enrolment.findFirst({ where: { academicYearId: year.id, studentId: id }, select: { rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : null;
        name = fullName(s);
        code = s.admissionNo;
        photoFileId = s.photoFileId;
        cls = e?.section.schoolClass.shortName ?? null;
        detail = e ? `${sectionLabel(e.section)}${e.rollNumber ? ` · roll ${e.rollNumber}` : ''}` : 'Not enrolled this session';
        active = s.status === 'active';
    } else {
        const s = await db.staff.findFirst({ where: { id }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, photoFileId: true, status: true, designationId: true } });
        if (!s) throw notFound('Staff member not found');
        const d = s.designationId ? await db.masterValue.findFirst({ where: { id: s.designationId }, select: { name: true } }) : null;
        name = fullName(s);
        code = s.employeeCode;
        photoFileId = s.photoFileId;
        detail = d?.name ?? 'Staff';
        active = s.status === 'working';
    }
    const where = kind === 'staff' ? { staffId: id } : { studentId: id };
    const [limits, loans, reservations, fines] = await Promise.all([
        limitsFor(kind, cls),
        db.libraryLoan.findMany({ where: { ...where, status: 'out' }, orderBy: { dueOn: 'asc' }, include: { copy: { select: { accessionNo: true, book: { select: { id: true, title: true, authors: true } } } } } }),
        db.libraryReservation.findMany({ where: { ...where, status: { in: ['waiting', 'ready'] } }, orderBy: { createdAt: 'asc' } }),
        unpaidFines(kind, id),
    ]);
    const titles = new Map((await db.book.findMany({ where: { id: { in: reservations.map((r) => r.bookId) } }, select: { id: true, title: true } })).map((b) => [b.id, b.title]));
    const today = todayIST();
    return {
        kind,
        id,
        name,
        code,
        detail,
        photoFileId,
        active,
        limits,
        loans: loans.map((l) => ({ id: l.id, accessionNo: l.copy.accessionNo, bookId: l.copy.book.id, title: l.copy.book.title, authors: l.copy.book.authors, issuedOn: isoOf(l.issuedOn), dueOn: isoOf(l.dueOn), overdue: isoOf(l.dueOn) < today, renewals: l.renewals })),
        reservations: reservations.map((r) => ({ id: r.id, bookId: r.bookId, title: titles.get(r.bookId) ?? '', status: r.status, holdUntil: r.holdUntil ? isoOf(r.holdUntil) : null })),
        fines,
    };
};

/**
 * Finds members for the counter: by a school ID card's number (its QR / barcode, or a link ending in
 * it), by admission no / employee code (exact, what the library card's barcode has), or by name.
 */
export const searchMembers = async (q: string) => {
    const text = q.trim();
    if (text.length < 2) return [];
    const year = await currentYear();
    const last = text.split(/[/=?#]/).filter(Boolean).pop() ?? text;
    const card = await db.idCard.findFirst({ where: { cardNo: { equals: last, mode: 'insensitive' }, status: { not: 'cancelled' } }, select: { studentId: true, staffId: true } });
    const [students, staff] = await Promise.all([
        db.student.findMany({ where: card ? { id: card.studentId ?? '00000000-0000-0000-0000-000000000000' } : { status: 'active', OR: [{ admissionNo: { equals: text, mode: 'insensitive' } }, { admissionNo: { equals: text.replace(/^(\d{4})(\d+)$/, '$1/$2') } }, { firstName: { startsWith: text, mode: 'insensitive' } }, { lastName: { startsWith: text, mode: 'insensitive' } }, { user: { username: { equals: text, mode: 'insensitive' } } }] }, take: 15, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.staff.findMany({ where: card ? { id: card.staffId ?? '00000000-0000-0000-0000-000000000000' } : { status: 'working', OR: [{ employeeCode: { equals: text, mode: 'insensitive' } }, { firstName: { startsWith: text, mode: 'insensitive' } }, { lastName: { startsWith: text, mode: 'insensitive' } }] }, take: 10, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
    ]);
    const enrol = year ? await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [];
    return [
        ...students.map((s) => {
            const e = enrol.find((x) => x.studentId === s.id);
            return { kind: 'student' as const, id: s.id, name: fullName(s), code: s.admissionNo, detail: e ? sectionLabel(e.section) : '' };
        }),
        ...staff.map((s) => ({ kind: 'staff' as const, id: s.id, name: fullName(s), code: s.employeeCode, detail: 'Staff' })),
    ];
};

/** The members a login is (or looks after): a student, a parent's children, or a staff member. */
export const myMembers = async (userId: string): Promise<{ kind: MemberKind; id: string; name: string }[]> => {
    const [students, staff] = await Promise.all([
        db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true }, orderBy: { firstName: 'asc' } }),
        db.staff.findFirst({ where: { userId, status: 'working' }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
    ]);
    return [...(staff ? [{ kind: 'staff' as const, id: staff.id, name: fullName(staff) }] : []), ...students.map((s) => ({ kind: 'student' as const, id: s.id, name: fullName(s) }))];
};

// ─── Library cards ───────────────────────────────────────────────────────────

export const cardsQuery = z.object({ section: z.uuid().optional(), staff: z.enum(['1']).optional(), student: z.uuid().optional(), staffId: z.uuid().optional() });

/** Members for printing library cards: a section's students, all working staff, or one person. */
export const cards = async (q: z.infer<typeof cardsQuery>) => {
    const year = await currentYear();
    const school = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true, logoFileId: true, phone: true } });
    const out: { kind: MemberKind; id: string; name: string; code: string; detail: string; type: string; books: number; days: number; hasPhoto: boolean }[] = [];
    if (q.section || q.student) {
        const enrol = year ? await db.enrolment.findMany({ where: { academicYearId: year.id, ...(q.section ? { sectionId: q.section } : { studentId: q.student }), student: { status: 'active' } }, orderBy: [{ rollNumber: 'asc' }], select: { rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } } } }) : [];
        for (const e of enrol) {
            const l = await limitsFor('student', e.section.schoolClass.shortName);
            out.push({ kind: 'student', id: e.student.id, name: fullName(e.student), code: e.student.admissionNo, detail: `${sectionLabel(e.section)}${e.rollNumber ? ` · roll ${e.rollNumber}` : ''}`, type: l.type, books: l.books, days: l.days, hasPhoto: !!e.student.photoFileId });
        }
    }
    if (q.staff || q.staffId) {
        const staff = await db.staff.findMany({ where: { status: 'working', ...(q.staffId ? { id: q.staffId } : {}) }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, photoFileId: true, designationId: true } });
        const des = new Map((await db.masterValue.findMany({ where: { id: { in: staff.map((s) => s.designationId!).filter(Boolean) } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
        const l = await limitsFor('staff', null);
        for (const s of staff) out.push({ kind: 'staff', id: s.id, name: fullName(s), code: s.employeeCode, detail: des.get(s.designationId ?? '') ?? 'Staff', type: l.type, books: l.books, days: l.days, hasPhoto: !!s.photoFileId });
    }
    return { school: { name: school?.shortName ?? school?.legalName ?? '', fullName: school?.legalName ?? '', phone: school?.phone ?? null, hasLogo: !!school?.logoFileId }, validTill: year ? isoOf(year.endDate) : null, session: year?.name ?? null, cards: out };
};

/** The photo file of a member (for the card), or null. */
export const memberPhoto = async (kind: MemberKind, id: string) =>
    kind === 'staff' ? ((await db.staff.findFirst({ where: { id }, select: { photoFileId: true } }))?.photoFileId ?? null) : ((await db.student.findFirst({ where: { id }, select: { photoFileId: true } }))?.photoFileId ?? null);
export const schoolLogo = async () => (await db.schoolProfile.findFirst({ select: { logoFileId: true } }))?.logoFileId ?? null;
