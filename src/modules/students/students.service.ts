import { Prisma, type DataScope, type StudentStatus } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { formatNumber, peekNumber, takeNumbers } from '../../core/numbering';
import { ListQuery, listResult } from '../../core/http/list-query';
import { createLogin, sendWelcomeEmail } from '../auth/account.service';
import { revokeUserSessions } from '../auth/session.service';
import { currentYear } from '../academic/years.service';
import { ACADEMIC } from '../academic/academic.settings';
import { STUDENTS, StudentField } from './students.settings';
import { checkPlacement, enrolmentSchema, renumberSection, saveEnrolment } from './enrolment.service';
import { guardianSchema, createGuardians } from './family.service';
import type { studentFilters } from './students.schemas';
import { assertConvertible, markConverted, type Viewer as EnquiryViewer } from '../admissions/enquiries.service';
import { checkStudentLimit } from '../platform/limits';

/** Student records, admission and the student list. */

// ─── Who is looking ──────────────────────────────────────────────────────────

/** The viewer's reach (scope of student.view) and whether they may see sensitive fields. */
export interface Viewer {
    userId: string;
    scope: DataScope;
    sensitive: boolean;
}

/** Students the viewer may see: everyone, their class-teacher sections (this year), or their own / children. */
export const scopeWhere = async (viewer: Viewer): Promise<Prisma.StudentWhereInput> => {
    if (viewer.scope === 'all') return {};
    if (viewer.scope === 'assigned') {
        const year = await currentYear();
        const mine = { staff: { userId: viewer.userId } };
        return {
            enrolments: {
                some: { ...(year ? { academicYearId: year.id } : {}), section: { OR: [{ classTeacher: { userId: viewer.userId } }, { teachingAssignments: { some: mine } }] } },
            },
        };
    }
    return { OR: [{ userId: viewer.userId }, { family: { guardians: { some: { userId: viewer.userId } } } }] };
};

const assertVisible = async (id: string, viewer: Viewer) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Student not found');
    const found = await db.student.findFirst({ where: { id, ...(await scopeWhere(viewer)) }, select: { id: true } });
    if (!found) throw notFound('Student not found');
};

const mask = (v: string | null, show: boolean) => (v && !show ? `••••${v.slice(-4)}` : v);

export const fullName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

// ─── Fields ──────────────────────────────────────────────────────────────────

const text = (max: number) =>
    z
        .union([z.literal('').transform(() => null), z.string().trim().max(max, `must be at most ${max} characters`), z.null()])
        .optional();
const id = z.uuid('choose one from the list').nullable().optional();
const digits = (n: number, label: string) =>
    z
        .union([z.literal('').transform(() => null), z.string().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(new RegExp(`^\\d{${n}}$`), `must be ${n} digits${label}`)), z.null()])
        .optional();
const day = z.iso.date('must be a date like 2015-08-15');

export const studentFieldsSchema = z.strictObject({
    admissionNo: text(40),
    admissionDate: day.optional(),
    admissionTypeId: id,
    firstName: z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters'),
    middleName: text(80),
    lastName: text(80),
    dateOfBirth: day.nullable().optional(),
    genderId: id,
    bloodGroupId: id,
    religionId: id,
    casteCategoryId: id,
    motherTongueId: id,
    nationalityId: id,
    disabilityId: id,
    categoryId: id,
    aadhaar: digits(12, ''),
    apaarId: digits(12, ''),
    pen: text(20),
    mobile: z.union([z.literal('').transform(() => null), z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid mobile number'), z.null()]).optional(),
    email: z.union([z.literal('').transform(() => null), z.string().trim().toLowerCase().email('is not a valid email'), z.null()]).optional(),
    addressLine: text(200),
    stateId: id,
    districtId: id,
    cityId: id,
    pinCode: digits(6, ''),
    previousSchool: text(150),
    previousBoardId: id,
    previousClass: text(20),
    tcNumber: text(40),
    medicalNotes: text(500),
    emergencyName: text(120),
    emergencyPhone: z.union([z.literal('').transform(() => null), z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid phone number'), z.null()]).optional(),
});
export const studentUpdateSchema = studentFieldsSchema.partial();
type StudentFields = z.infer<typeof studentUpdateSchema>;

/** Which master list each field picks from. */
const MASTER_OF: Record<string, string> = {
    admissionTypeId: 'admission_type',
    genderId: 'gender',
    bloodGroupId: 'blood_group',
    religionId: 'religion',
    casteCategoryId: 'caste_category',
    motherTongueId: 'mother_tongue',
    nationalityId: 'nationality',
    disabilityId: 'disability',
    categoryId: 'student_category',
    stateId: 'state',
    districtId: 'district',
    cityId: 'city',
    previousBoardId: 'previous_board',
};

/** Columns of each configurable field (System Settings → Students → required / hidden). */
const COLUMNS: Record<StudentField, string[]> = {
    middleName: ['middleName'],
    lastName: ['lastName'],
    dateOfBirth: ['dateOfBirth'],
    genderId: ['genderId'],
    bloodGroupId: ['bloodGroupId'],
    religionId: ['religionId'],
    casteCategoryId: ['casteCategoryId'],
    categoryId: ['categoryId'],
    motherTongueId: ['motherTongueId'],
    nationalityId: ['nationalityId'],
    disabilityId: ['disabilityId'],
    aadhaar: ['aadhaar'],
    apaarId: ['apaarId'],
    pen: ['pen'],
    mobile: ['mobile'],
    email: ['email'],
    address: ['addressLine', 'stateId', 'districtId', 'cityId', 'pinCode'],
    previousSchool: ['previousSchool', 'previousBoardId', 'previousClass', 'tcNumber'],
    medicalNotes: ['medicalNotes'],
    emergency: ['emergencyName', 'emergencyPhone'],
    guardian: [],
};

/** Field problems: wrong master options, a place that doesn't belong to the one above, required fields missing. */
const checkFields = async (f: StudentFields, required: StudentField[] | null, client: typeof db | Tx = db) => {
    const issues: { field: string; message: string }[] = [];
    const ids = Object.entries(MASTER_OF).flatMap(([field, master]) => ((f as Record<string, unknown>)[field] ? [{ field, master, id: (f as Record<string, string>)[field] }] : []));
    if (ids.length) {
        const rows = await client.masterValue.findMany({ where: { id: { in: ids.map((i) => i.id) } }, select: { id: true, master: true, parentId: true } });
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const i of ids) if (byId.get(i.id)?.master !== i.master) issues.push({ field: i.field, message: 'is not an option of its list' });
        if (f.districtId && f.stateId && byId.get(f.districtId)?.parentId !== f.stateId) issues.push({ field: 'districtId', message: 'is not in the chosen state' });
        if (f.cityId && f.districtId && byId.get(f.cityId)?.parentId !== f.districtId) issues.push({ field: 'cityId', message: 'is not in the chosen district' });
    }
    for (const r of required ?? []) {
        if (r === 'guardian') continue;
        const cols = r === 'address' ? ['addressLine'] : r === 'previousSchool' ? ['previousSchool'] : r === 'emergency' ? ['emergencyName', 'emergencyPhone'] : COLUMNS[r];
        for (const c of cols) if (!(f as Record<string, unknown>)[c]) issues.push({ field: c, message: 'is required' });
    }
    if (f.dateOfBirth && f.dateOfBirth > new Date().toISOString().slice(0, 10)) issues.push({ field: 'dateOfBirth', message: 'is in the future' });
    if (issues.length) throw badRequest(issues.length === 1 ? `${issues[0].field} ${issues[0].message}` : 'Some fields need attention', issues);
};

/** Hidden fields are not saved (the school doesn't use them). */
const withoutHidden = <T extends Record<string, unknown>>(f: T, hidden: StudentField[]) => {
    const out = { ...f };
    for (const h of hidden) for (const c of COLUMNS[h]) delete (out as Record<string, unknown>)[c];
    return out;
};

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dbFields = (f: StudentFields) => ({
    ...f,
    ...(f.admissionDate ? { admissionDate: toDate(f.admissionDate) } : {}),
    ...(f.dateOfBirth !== undefined ? { dateOfBirth: f.dateOfBirth ? toDate(f.dateOfBirth) : null } : {}),
});

const uniqueChecks = async (f: StudentFields, exceptId?: string) => {
    const except = exceptId ? { id: { not: exceptId } } : {};
    const checks: [keyof StudentFields, string][] = [
        ['admissionNo', 'admission number'],
        ['aadhaar', 'Aadhaar number'],
        ['apaarId', 'APAAR ID'],
        ['pen', 'PEN'],
    ];
    for (const [field, label] of checks) {
        const v = f[field] as string | null | undefined;
        if (!v) continue;
        const other = await db.student.findFirst({ where: { [field]: field === 'admissionNo' ? { equals: v, mode: 'insensitive' } : v, ...except }, select: { firstName: true, lastName: true } });
        if (other) throw conflict(`This ${label} is already ${fullName(other)}'s`);
    }
};

// ─── Admission number ────────────────────────────────────────────────────────

export const counterKey = (reset: string, parts: { date: Date; academicYear?: string; classId?: string }) =>
    reset === 'academic_year' ? `admission:${parts.academicYear}` : reset === 'calendar_year' ? `admission:${parts.date.getUTCFullYear()}` : reset === 'class' ? `admission:class:${parts.classId}` : 'admission';

/** Next admission number for a class (shown on the form; nothing is reserved). */
export const previewAdmissionNumber = async (sectionId?: string) => {
    const s = await getSettings({ pattern: STUDENTS.admissionPattern, reset: STUDENTS.admissionReset, start: STUDENTS.admissionStart, editable: STUDENTS.admissionEditable });
    const section = sectionId ? await db.section.findUnique({ where: { id: sectionId }, include: { schoolClass: true, academicYear: true } }) : null;
    const year = section?.academicYear ?? (await currentYear());
    const parts = { date: new Date(), academicYear: year?.name, classId: section?.classId, className: section?.schoolClass.shortName ?? section?.schoolClass.name };
    const seq = await peekNumber(counterKey(s.reset, parts), s.start);
    return { next: formatNumber(s.pattern, { ...parts, seq }), editable: s.editable, pattern: s.pattern };
};

const allocateAdmissionNumber = async (parts: { date: Date; academicYear: string; classId: string; className: string }) => {
    const s = await getSettings({ pattern: STUDENTS.admissionPattern, reset: STUDENTS.admissionReset, start: STUDENTS.admissionStart });
    // A number typed by hand earlier may already exist; take the next one then.
    for (let i = 0; i < 50; i++) {
        const seq = await takeNumbers(counterKey(s.reset, parts), s.start);
        const no = formatNumber(s.pattern, { ...parts, seq });
        if (!(await db.student.findFirst({ where: { admissionNo: { equals: no, mode: 'insensitive' } }, select: { id: true } }))) return no;
    }
    throw conflict('Could not find a free admission number. Check the admission number pattern in System Settings.');
};

// ─── Reading ─────────────────────────────────────────────────────────────────

const ref = { select: { id: true, name: true } } as const;
const studentInclude = {
    admissionType: ref,
    gender: ref,
    bloodGroup: ref,
    religion: ref,
    casteCategory: ref,
    motherTongue: ref,
    nationality: ref,
    disability: ref,
    category: ref,
    state: ref,
    district: ref,
    city: ref,
    previousBoard: ref,
    leavingReason: ref,
    user: { select: { id: true, username: true, status: true, lastLoginAt: true } },
    family: {
        include: {
            guardians: { include: { relation: ref, occupation: ref, qualification: ref, incomeRange: ref, user: { select: { id: true, username: true, status: true } } }, orderBy: [{ isPrimary: 'desc' as const }, { sortOrder: 'asc' as const }] },
            students: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, status: true } },
        },
    },
    enrolments: {
        include: { academicYear: { select: { id: true, name: true, isCurrent: true, startDate: true } }, section: { include: { schoolClass: { select: { id: true, name: true, shortName: true } }, stream: ref } }, house: ref },
        orderBy: { academicYear: { startDate: 'desc' as const } },
    },
    documents: { include: { type: ref, file: { select: { originalName: true, mimeType: true, sizeBytes: true } } }, orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.StudentInclude;
type StudentRow = Prisma.StudentGetPayload<{ include: typeof studentInclude }>;

const sectionLabel = (s: { name: string; schoolClass: { name: string; shortName: string | null }; stream?: { name: string } | null }) =>
    `${s.schoolClass.shortName ?? s.schoolClass.name}-${s.name}${s.stream ? ` (${s.stream.name})` : ''}`;
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const present = (s: StudentRow, viewer: Viewer) => {
    const show = viewer.sensitive;
    return {
        id: s.id,
        admissionNo: s.admissionNo,
        admissionDate: dayOf(s.admissionDate),
        admissionType: s.admissionType,
        name: fullName(s),
        firstName: s.firstName,
        middleName: s.middleName,
        lastName: s.lastName,
        dateOfBirth: dayOf(s.dateOfBirth),
        gender: s.gender,
        bloodGroup: s.bloodGroup,
        religion: s.religion,
        casteCategory: s.casteCategory,
        motherTongue: s.motherTongue,
        nationality: s.nationality,
        disability: s.disability,
        category: s.category,
        aadhaar: mask(s.aadhaar, show),
        apaarId: s.apaarId,
        pen: s.pen,
        mobile: s.mobile,
        email: s.email,
        addressLine: s.addressLine,
        state: s.state,
        district: s.district,
        city: s.city,
        pinCode: s.pinCode,
        previousSchool: s.previousSchool,
        previousBoard: s.previousBoard,
        previousClass: s.previousClass,
        tcNumber: s.tcNumber,
        medicalNotes: show ? s.medicalNotes : s.medicalNotes ? '(hidden)' : null,
        emergencyName: s.emergencyName,
        emergencyPhone: s.emergencyPhone,
        photoUrl: s.photoFileId ? `students/${s.id}/photo?v=${s.photoFileId}` : null,
        status: s.status,
        statusDate: dayOf(s.statusDate),
        leavingReason: s.leavingReason,
        statusNote: s.statusNote,
        login: s.user,
        sensitiveShown: show,
        family: s.family
            ? {
                  id: s.family.id,
                  guardians: s.family.guardians.map((g) => ({
                      id: g.id,
                      relation: g.relation,
                      name: g.name,
                      mobile: g.mobile,
                      email: g.email,
                      occupation: g.occupation,
                      qualification: g.qualification,
                      incomeRange: show ? g.incomeRange : null,
                      aadhaar: mask(g.aadhaar, show),
                      isPrimary: g.isPrimary,
                      login: g.user,
                  })),
                  siblings: s.family.students.filter((x) => x.id !== s.id).map((x) => ({ id: x.id, name: fullName(x), admissionNo: x.admissionNo, status: x.status })),
              }
            : null,
        enrolments: s.enrolments.map((e) => ({
            id: e.id,
            academicYear: e.academicYear,
            section: { id: e.section.id, label: sectionLabel(e.section), classId: e.section.schoolClass.id, className: e.section.schoolClass.name, stream: e.section.stream },
            rollNumber: e.rollNumber,
            house: e.house,
            optionalSubjectIds: e.optionalSubjectIds,
        })),
        documents: s.documents.map((d) => ({ id: d.id, type: d.type, note: d.note, fileName: d.file.originalName, mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes, createdAt: d.createdAt })),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
};

export const getStudent = async (id: string, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const s = await db.student.findUnique({ where: { id }, include: studentInclude });
    if (!s) throw notFound('Student not found');
    return present(s, viewer);
};

type Filters = ListQuery<typeof studentFilters>['filters'];

/** The student list, one row per student placed in the chosen year (default: the current year). */
export const listStudents = async (q: ListQuery<typeof studentFilters>, viewer: Viewer) => {
    const f: Filters = q.filters;
    const year = f.year ? { id: f.year } : await currentYear();
    if (!year) return listResult([], 0, q);
    const search = q.search?.trim();
    const where: Prisma.EnrolmentWhereInput = {
        academicYearId: year.id,
        ...(f.section ? { sectionId: f.section } : {}),
        ...(f.class ? { section: { classId: f.class } } : {}),
        ...(f.house ? { houseId: f.house } : {}),
        student: {
            AND: [
                await scopeWhere(viewer),
                f.status ? { status: f.status } : { status: 'active' },
                ...(f.gender ? [{ genderId: f.gender }] : []),
                ...(f.category ? [{ categoryId: f.category }] : []),
                ...(f.caste ? [{ casteCategoryId: f.caste }] : []),
                ...(search
                    ? [
                          {
                              OR: [
                                  { firstName: { contains: search, mode: 'insensitive' as const } },
                                  { lastName: { contains: search, mode: 'insensitive' as const } },
                                  { admissionNo: { contains: search, mode: 'insensitive' as const } },
                                  { family: { guardians: { some: { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { mobile: { contains: search.replace(/\D/g, '') || search } }] } } } },
                              ],
                          },
                      ]
                    : []),
            ],
        },
    };
    const dir = q.order;
    const orderBy: Prisma.EnrolmentOrderByWithRelationInput[] =
        q.sort === 'roll'
            ? [{ section: { schoolClass: { sortOrder: 'asc' } } }, { section: { sortOrder: 'asc' } }, { rollNumber: { sort: dir, nulls: 'last' } }, { student: { firstName: 'asc' } }]
            : q.sort === 'admissionNo'
              ? [{ student: { admissionNo: dir } }]
              : q.sort === 'admissionDate'
                ? [{ student: { admissionDate: dir } }]
                : q.sort === 'class'
                  ? [{ section: { schoolClass: { sortOrder: dir } } }, { section: { sortOrder: dir } }, { student: { firstName: 'asc' } }]
                  : [{ student: { firstName: dir } }, { student: { lastName: dir } }];
    const [rows, total] = await Promise.all([
        db.enrolment.findMany({
            where,
            orderBy,
            skip: q.skip,
            take: q.take,
            include: {
                house: ref,
                section: { include: { schoolClass: { select: { id: true, name: true, shortName: true } }, stream: ref } },
                student: {
                    include: {
                        gender: ref,
                        family: { select: { guardians: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1, select: { name: true, mobile: true, relation: ref } } } },
                    },
                },
            },
        }),
        db.enrolment.count({ where }),
    ]);
    return listResult(
        rows.map((e) => ({
            id: e.student.id,
            admissionNo: e.student.admissionNo,
            name: fullName(e.student),
            gender: e.student.gender,
            dateOfBirth: dayOf(e.student.dateOfBirth),
            status: e.student.status,
            photoUrl: e.student.photoFileId ? `students/${e.student.id}/photo?v=${e.student.photoFileId}` : null,
            section: { id: e.section.id, label: sectionLabel(e.section), classId: e.section.schoolClass.id },
            rollNumber: e.rollNumber,
            house: e.house,
            contact: e.student.family?.guardians[0] ?? null,
        })),
        total,
        q
    );
};

// ─── Admission ───────────────────────────────────────────────────────────────

export const admissionSchema = z.strictObject({
    student: studentFieldsSchema,
    /** A sibling's family (its parents are shared), or new parents / guardians below. */
    familyId: z.uuid().optional(),
    guardians: z.array(guardianSchema).max(6).optional(),
    enrolment: enrolmentSchema,
    /** Create the student's login now (when System Settings → Students says "when asked"). */
    createLogin: z.boolean().optional(),
    /** The admission enquiry this admission comes from (Convert to admission). */
    enquiryId: z.uuid().optional(),
});
export type AdmissionInput = z.infer<typeof admissionSchema>;

export interface LoginCreated {
    username: string;
    temporaryPassword: string;
    for: string;
    emailed: boolean;
}

/** Login usernames from the admission number (2026/0001 → 20260001) or the name. */
const studentUsernames = (byNumber: boolean, admissionNo: string, name: string) => (byNumber ? [admissionNo.replace(/[^A-Za-z0-9]/g, ''), name] : [name, admissionNo]);

export const createStudentLogin = async (studentId: string, client: typeof db | Tx = db) => {
    const s = await client.student.findUnique({ where: { id: studentId } });
    if (!s) throw notFound('Student not found');
    if (s.userId) throw conflict('This student already has a login');
    const { byNumber } = await getSettings({ byNumber: STUDENTS.studentUsername }).then((x) => ({ byNumber: x.byNumber === 'admission_number' }));
    const login = await createLogin(
        { kind: 'student', displayName: fullName(s), email: s.email, mobile: null, usernameCandidates: studentUsernames(byNumber, s.admissionNo, fullName(s)), dateOfBirth: s.dateOfBirth },
        client
    );
    await client.student.update({ where: { id: studentId }, data: { userId: login.user.id } });
    return login;
};

/** `enquiry`: who converts the enquiry in `input.enquiryId` (the route checks enquiry.convert). */
export const admitStudent = async (input: AdmissionInput, viewer: Viewer, enquiry?: EnquiryViewer) => {
    await checkStudentLimit();
    if (input.enquiryId) await assertConvertible(input.enquiryId, enquiry ?? { userId: viewer.userId, scope: 'all' });
    const s = await getSettings({
        required: STUDENTS.requiredFields,
        hidden: STUDENTS.hiddenFields,
        editable: STUDENTS.admissionEditable,
        studentLogin: STUDENTS.studentLogin,
        parentLogin: STUDENTS.parentLogin,
        houses: ACADEMIC.housesEnabled,
    });
    const fields = withoutHidden(input.student, s.hidden);
    await checkFields(fields, s.required);
    if (s.required.includes('guardian') && !input.familyId && !input.guardians?.length) {
        throw badRequest('Add at least one parent or guardian (or link a sibling)', [{ field: 'guardians', message: 'add at least one parent or guardian' }]);
    }
    if (fields.admissionNo && !s.editable) throw badRequest('Admission numbers are given automatically', [{ field: 'admissionNo', message: 'is given automatically' }]);
    await uniqueChecks(fields);
    if (input.familyId && !(await db.family.findUnique({ where: { id: input.familyId }, select: { id: true } }))) throw badRequest('That family was not found', [{ field: 'familyId', message: 'was not found' }]);
    const { section } = await checkPlacement(input.enrolment, null);
    const enrolment = s.houses ? input.enrolment : { ...input.enrolment, houseId: null };

    const admissionDate = fields.admissionDate ? toDate(fields.admissionDate) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const year = await db.academicYear.findUniqueOrThrow({ where: { id: input.enrolment.academicYearId } });
    const admissionNo =
        fields.admissionNo ?? (await allocateAdmissionNumber({ date: admissionDate, academicYear: year.name, classId: section.classId, className: section.schoolClass.shortName ?? section.schoolClass.name }));

    const tenantId = getTenantId()!;
    const logins: (LoginCreated & { user: { id: string } })[] = [];
    const welcomes: Parameters<typeof sendWelcomeEmail>[0][] = [];
    const result = await withTransaction(
        async (tx) => {
            const familyId = input.familyId ?? (await tx.family.create({ data: { tenantId } })).id;
            const guardians = input.guardians?.length ? await createGuardians(familyId, input.guardians, tx) : [];
            const student = await tx.student.create({ data: { tenantId, ...dbFields({ ...fields, admissionNo }), firstName: fields.firstName, admissionNo, admissionDate, familyId } as Prisma.StudentUncheckedCreateInput });
            const placed = await saveEnrolment(student.id, enrolment, tx);
            if (input.enquiryId) await markConverted(tx, input.enquiryId, student.id);

            if (s.studentLogin === 'auto' || (s.studentLogin === 'on_request' && input.createLogin)) {
                const login = await createStudentLogin(student.id, tx);
                logins.push({ for: fullName(student), username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome, user: login.user });
                welcomes.push(login);
            }
            if (s.parentLogin === 'auto') {
                const primary = guardians.find((g) => g.isPrimary) ?? guardians[0];
                if (primary && !primary.userId && (primary.mobile || primary.email)) {
                    const taken = await tx.user.findFirst({ where: { OR: [...(primary.mobile ? [{ mobile: primary.mobile }] : []), ...(primary.email ? [{ email: primary.email }] : [])] }, select: { id: true } });
                    if (!taken) {
                        const login = await createLogin({ kind: 'guardian', displayName: primary.name, email: primary.email, mobile: primary.mobile, usernameCandidates: [primary.mobile ?? '', primary.name] }, tx);
                        await tx.guardian.update({ where: { id: primary.id }, data: { userId: login.user.id } });
                        logins.push({ for: primary.name, username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome, user: login.user });
                        welcomes.push(login);
                    }
                }
            }
            return { student, placed };
        },
        { timeout: 60_000 }
    );
    for (const w of welcomes) await sendWelcomeEmail(w);
    if (result.placed.renumber) await renumberSection(result.placed.section.id);
    await recordAudit({ action: 'admit', entity: 'student', entityId: result.student.id, changes: { admissionNo, section: `${section.schoolClass.name} ${section.name}`, ...(input.enquiryId ? { enquiryId: input.enquiryId } : {}) } });
    return {
        student: await getStudent(result.student.id, { ...viewer, scope: 'all' }),
        logins: logins.map(({ user: _u, ...l }) => l),
        warning: result.placed.warning,
    };
};

// ─── Changing ────────────────────────────────────────────────────────────────

export const updateStudent = async (id: string, input: StudentFields, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const current = await db.student.findUniqueOrThrow({ where: { id } });
    const s = await getSettings({ hidden: STUDENTS.hiddenFields, editable: STUDENTS.admissionEditable, required: STUDENTS.requiredFields });
    const fields = withoutHidden(input, s.hidden);
    if (fields.admissionNo !== undefined && fields.admissionNo !== current.admissionNo && !s.editable) {
        throw badRequest('Admission numbers are given automatically', [{ field: 'admissionNo', message: "can't be changed by hand" }]);
    }
    if (fields.admissionNo === null) throw badRequest('Admission number is required', [{ field: 'admissionNo', message: 'is required' }]);
    // Required fields are checked against the record as it will be after the change.
    const merged = { ...current, dateOfBirth: dayOf(current.dateOfBirth), admissionDate: dayOf(current.admissionDate) ?? undefined, ...fields } as unknown as StudentFields;
    await checkFields(merged, s.required);
    await uniqueChecks(fields, id);
    // Sensitive fields are only changed by people who may see them.
    if (!viewer.sensitive) {
        delete fields.aadhaar;
        delete fields.medicalNotes;
    }
    await db.student.update({ where: { id }, data: dbFields(fields) as Prisma.StudentUpdateInput });
    return getStudent(id, viewer);
};

export const statusSchema = z.strictObject({
    status: z.enum(['active', 'left', 'passed_out', 'struck_off']),
    date: day.optional(),
    leavingReasonId: z.uuid().nullable().optional(),
    note: text(300),
});

/** Leaving (or coming back): the student's login is switched off while they are not active. */
export const setStatus = async (id: string, input: z.infer<typeof statusSchema>, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const s = await db.student.findUniqueOrThrow({ where: { id } });
    if (input.leavingReasonId && !(await db.masterValue.findFirst({ where: { id: input.leavingReasonId, master: 'leaving_reason' } }))) {
        throw badRequest('Choose a leaving reason from the list', [{ field: 'leavingReasonId', message: 'is not a leaving reason' }]);
    }
    const active = input.status === 'active';
    await db.student.update({
        where: { id },
        data: {
            status: input.status as StudentStatus,
            statusDate: active ? null : toDate(input.date ?? new Date().toISOString().slice(0, 10)),
            leavingReasonId: active ? null : input.leavingReasonId ?? null,
            statusNote: active ? null : input.note ?? null,
        },
    });
    if (s.userId) {
        await db.user.update({ where: { id: s.userId }, data: { status: active ? 'active' : 'disabled' } });
        if (!active) await revokeUserSessions(s.userId, 'admin');
    }
    return getStudent(id, viewer);
};

/** Login for a student who has none (System Settings → Students → "when asked"). */
export const addStudentLogin = async (id: string, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const { mode } = await getSettings({ mode: STUDENTS.studentLogin });
    if (mode === 'off') throw forbidden('Student logins are switched off (System Settings → Students)');
    const login = await withTransaction((tx) => createStudentLogin(id, tx));
    await sendWelcomeEmail(login);
    return { username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome };
};

/** What the admission form needs to know (fields to show, numbering, logins). */
export const formConfig = async () => {
    const s = await getSettings({
        required: STUDENTS.requiredFields,
        hidden: STUDENTS.hiddenFields,
        editable: STUDENTS.admissionEditable,
        studentLogin: STUDENTS.studentLogin,
        parentLogin: STUDENTS.parentLogin,
        rollOrder: STUDENTS.rollOrder,
        houses: ACADEMIC.housesEnabled,
        capacity: STUDENTS.capacityCheck,
    });
    return s;
};
