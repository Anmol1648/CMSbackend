import { Prisma, type StaffStatus } from '@prisma/client';
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
import { normalizeMobile } from '../auth/identity';
import { currentYear } from '../academic/years.service';
import { STAFF, StaffField, SelfEditField } from './staff.settings';
import type { staffFilters } from './staff.schemas';
import { checkCustom, formExtras, visibleValues } from '../forms/forms.service';

/** Staff records, their logins, qualifications and experience. */

export interface Viewer {
    userId: string;
    /** all = everyone; own = only their own record. */
    scope: 'all' | 'assigned' | 'own';
    sensitive: boolean;
}

const scopeWhere = (v: Viewer): Prisma.StaffWhereInput => (v.scope === 'own' ? { userId: v.userId } : {});

const assertVisible = async (id: string, viewer: Viewer) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Staff member not found');
    if (!(await db.staff.findFirst({ where: { id, ...scopeWhere(viewer) }, select: { id: true } }))) throw notFound('Staff member not found');
};

export const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const mask = (v: string | null, show: boolean) => (v && !show ? `••••${v.slice(-4)}` : v);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// ─── Fields ──────────────────────────────────────────────────────────────────

const text = (max: number) =>
    z
        .union([z.literal('').transform(() => null), z.string().trim().max(max, `must be at most ${max} characters`), z.null()])
        .optional();
const id = z.uuid('choose one from the list').nullable().optional();
const day = z.iso.date('must be a date like 2015-08-15');
const phone = z.union([z.literal('').transform(() => null), z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid phone number'), z.null()]).optional();
const pattern = (re: RegExp, message: string, upper = false) =>
    z
        .union([
            z.literal('').transform(() => null),
            z
                .string()
                .transform((s) => (upper ? s.toUpperCase() : s).replace(/[\s-]/g, ''))
                .pipe(z.string().regex(re, message)),
            z.null(),
        ])
        .optional();

export const staffFieldsSchema = z.strictObject({
    employeeCode: text(40),
    joiningDate: day.optional(),
    firstName: z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters'),
    middleName: text(80),
    lastName: text(80),
    dateOfBirth: day.nullable().optional(),
    genderId: id,
    bloodGroupId: id,
    religionId: id,
    casteCategoryId: id,
    maritalStatusId: id,
    mobile: phone,
    email: z.union([z.literal('').transform(() => null), z.string().trim().toLowerCase().email('is not a valid email'), z.null()]).optional(),
    aadhaar: pattern(/^\d{12}$/, 'must be 12 digits'),
    pan: pattern(/^[A-Z]{5}\d{4}[A-Z]$/, 'must look like ABCDE1234F', true),
    addressLine: text(200),
    stateId: id,
    districtId: id,
    cityId: id,
    pinCode: pattern(/^\d{6}$/, 'must be 6 digits'),
    departmentId: id,
    designationId: id,
    staffTypeId: id,
    employmentTypeId: id,
    teachingPostId: id,
    reportsToId: id,
    teachableSubjectIds: z.array(z.uuid()).max(30).optional(),
    bankId: id,
    bankAccountNo: pattern(/^\d{6,20}$/, 'must be 6–20 digits'),
    ifsc: pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'must look like SBIN0001234', true),
    pfNumber: text(30),
    uan: pattern(/^\d{12}$/, 'must be 12 digits'),
    emergencyName: text(120),
    emergencyPhone: phone,
    /** Extra fields of the school (Setup → Form Builder): { key: value }. */
    custom: z.record(z.string(), z.unknown()).optional(),
});
export const staffUpdateSchema = staffFieldsSchema.partial();
type StaffFields = z.infer<typeof staffUpdateSchema>;

const MASTER_OF: Record<string, string> = {
    genderId: 'gender',
    bloodGroupId: 'blood_group',
    religionId: 'religion',
    casteCategoryId: 'caste_category',
    maritalStatusId: 'marital_status',
    stateId: 'state',
    districtId: 'district',
    cityId: 'city',
    departmentId: 'department',
    designationId: 'designation',
    staffTypeId: 'staff_type',
    employmentTypeId: 'employment_type',
    teachingPostId: 'teaching_post',
    bankId: 'bank',
};

const COLUMNS: Record<StaffField, string[]> = {
    middleName: ['middleName'],
    lastName: ['lastName'],
    dateOfBirth: ['dateOfBirth'],
    genderId: ['genderId'],
    bloodGroupId: ['bloodGroupId'],
    religionId: ['religionId'],
    casteCategoryId: ['casteCategoryId'],
    maritalStatusId: ['maritalStatusId'],
    mobile: ['mobile'],
    email: ['email'],
    aadhaar: ['aadhaar'],
    pan: ['pan'],
    address: ['addressLine', 'stateId', 'districtId', 'cityId', 'pinCode'],
    departmentId: ['departmentId'],
    designationId: ['designationId'],
    employmentTypeId: ['employmentTypeId'],
    bank: ['bankId', 'bankAccountNo', 'ifsc'],
    pf: ['pfNumber', 'uan'],
    emergency: ['emergencyName', 'emergencyPhone'],
};
const SENSITIVE = ['aadhaar', 'pan', 'bankAccountNo', 'pfNumber'] as const;

const checkFields = async (f: StaffFields, required: StaffField[], selfId?: string) => {
    const issues: { field: string; message: string }[] = [];
    const ids = Object.entries(MASTER_OF).flatMap(([field, master]) => ((f as Record<string, unknown>)[field] ? [{ field, master, id: (f as Record<string, string>)[field] }] : []));
    if (ids.length) {
        const rows = await db.masterValue.findMany({ where: { id: { in: ids.map((i) => i.id) } }, select: { id: true, master: true, parentId: true, extra: true } });
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const i of ids) if (byId.get(i.id)?.master !== i.master) issues.push({ field: i.field, message: 'is not an option of its list' });
        if (f.districtId && f.stateId && byId.get(f.districtId)?.parentId !== f.stateId) issues.push({ field: 'districtId', message: 'is not in the chosen state' });
        if (f.cityId && f.districtId && byId.get(f.cityId)?.parentId !== f.districtId) issues.push({ field: 'cityId', message: 'is not in the chosen district' });
        // An IFSC starts with the bank's 4 letters (Masters → Banks → IFSC prefix).
        const prefix = f.bankId ? ((byId.get(f.bankId)?.extra ?? {}) as { ifscPrefix?: string }).ifscPrefix : undefined;
        if (f.ifsc && prefix && !f.ifsc.startsWith(prefix)) issues.push({ field: 'ifsc', message: `should start with ${prefix} for this bank` });
    }
    if (f.reportsToId) {
        if (f.reportsToId === selfId) issues.push({ field: 'reportsToId', message: "can't be the person themself" });
        else if (!(await db.staff.findFirst({ where: { id: f.reportsToId }, select: { id: true } }))) issues.push({ field: 'reportsToId', message: 'is not a staff member' });
    }
    if (f.teachableSubjectIds?.length && (await db.subject.count({ where: { id: { in: f.teachableSubjectIds } } })) !== new Set(f.teachableSubjectIds).size) {
        issues.push({ field: 'teachableSubjectIds', message: 'contains an unknown subject' });
    }
    for (const r of required) {
        const cols = r === 'address' ? ['addressLine'] : r === 'bank' ? ['bankId', 'bankAccountNo', 'ifsc'] : r === 'pf' ? ['pfNumber'] : COLUMNS[r];
        for (const c of cols) if (!(f as Record<string, unknown>)[c]) issues.push({ field: c, message: 'is required' });
    }
    if (issues.length) throw badRequest(issues.length === 1 ? `${issues[0].field} ${issues[0].message}` : 'Some fields need attention', issues);
};

const withoutHidden = <T extends Record<string, unknown>>(f: T, hidden: StaffField[]) => {
    const out = { ...f };
    for (const h of hidden) for (const c of COLUMNS[h]) delete (out as Record<string, unknown>)[c];
    return out;
};

const dbFields = ({ custom: _custom, ...f }: StaffFields) => ({
    ...f,
    ...(f.mobile ? { mobile: normalizeMobile(f.mobile) } : {}),
    ...(f.joiningDate ? { joiningDate: toDate(f.joiningDate) } : {}),
    ...(f.dateOfBirth !== undefined ? { dateOfBirth: f.dateOfBirth ? toDate(f.dateOfBirth) : null } : {}),
});

const uniqueChecks = async (f: StaffFields, exceptId?: string) => {
    const except = exceptId ? { id: { not: exceptId } } : {};
    for (const [field, label] of [
        ['employeeCode', 'employee code'],
        ['aadhaar', 'Aadhaar number'],
        ['pan', 'PAN'],
    ] as const) {
        const v = f[field];
        if (!v) continue;
        const other = await db.staff.findFirst({ where: { [field]: { equals: v, mode: 'insensitive' }, ...except }, select: { firstName: true, lastName: true } });
        if (other) throw conflict(`This ${label} is already ${staffName(other)}'s`);
    }
};

// ─── Employee code ───────────────────────────────────────────────────────────

export const previewEmployeeCode = async () => {
    const s = await getSettings({ pattern: STAFF.codePattern, start: STAFF.codeStart, editable: STAFF.codeEditable });
    return { next: formatNumber(s.pattern, { seq: await peekNumber('staff', s.start), date: new Date() }), editable: s.editable, pattern: s.pattern };
};

export const allocateEmployeeCode = async (joining: Date) => {
    const s = await getSettings({ pattern: STAFF.codePattern, start: STAFF.codeStart });
    for (let i = 0; i < 50; i++) {
        const code = formatNumber(s.pattern, { seq: await takeNumbers('staff', s.start), date: joining });
        if (!(await db.staff.findFirst({ where: { employeeCode: { equals: code, mode: 'insensitive' } }, select: { id: true } }))) return code;
    }
    throw conflict('Could not find a free employee code. Check the pattern in System Settings → Staff.');
};

// ─── Reading ─────────────────────────────────────────────────────────────────

const ref = { select: { id: true, name: true } } as const;
const include = {
    gender: ref,
    bloodGroup: ref,
    religion: ref,
    casteCategory: ref,
    maritalStatus: ref,
    state: ref,
    district: ref,
    city: ref,
    department: ref,
    designation: ref,
    staffType: { select: { id: true, name: true, extra: true } },
    employmentType: ref,
    teachingPost: ref,
    bank: ref,
    relievingReason: ref,
    reportsTo: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
    user: { select: { id: true, username: true, status: true, lastLoginAt: true, roles: { select: { role: { select: { id: true, name: true } } } } } },
    qualifications: { include: { qualification: ref }, orderBy: { sortOrder: 'asc' as const } },
    experience: { orderBy: { sortOrder: 'asc' as const } },
    documents: { include: { type: ref, file: { select: { originalName: true, mimeType: true, sizeBytes: true } } }, orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.StaffInclude;
type Row = Prisma.StaffGetPayload<{ include: typeof include }>;

export const isTeachingType = (t: { extra: unknown } | null) => !!t && (t.extra as { teaching?: boolean }).teaching === true;

const present = async (s: Row, viewer: Viewer) => {
    const show = viewer.sensitive || (viewer.scope === 'own' && s.userId === viewer.userId);
    const year = await currentYear();
    const [classTeacherOf, assignments] = year
        ? await Promise.all([
              db.section.findMany({ where: { classTeacherId: s.id, academicYearId: year.id }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }),
              db.teachingAssignment.findMany({
                  where: { staffId: s.id, academicYearId: year.id },
                  select: { section: { select: { id: true, name: true, schoolClass: { select: { shortName: true, name: true, sortOrder: true } } } }, subject: ref },
              }),
          ])
        : [[], []];
    const label = (x: { name: string; schoolClass: { shortName: string | null; name: string } }) => `${x.schoolClass.shortName ?? x.schoolClass.name}-${x.name}`;
    return {
        id: s.id,
        employeeCode: s.employeeCode,
        joiningDate: dayOf(s.joiningDate),
        name: staffName(s),
        firstName: s.firstName,
        middleName: s.middleName,
        lastName: s.lastName,
        dateOfBirth: dayOf(s.dateOfBirth),
        gender: s.gender,
        bloodGroup: s.bloodGroup,
        religion: s.religion,
        casteCategory: s.casteCategory,
        maritalStatus: s.maritalStatus,
        mobile: s.mobile,
        email: s.email,
        aadhaar: mask(s.aadhaar, show),
        pan: mask(s.pan, show),
        addressLine: s.addressLine,
        state: s.state,
        district: s.district,
        city: s.city,
        pinCode: s.pinCode,
        department: s.department,
        designation: s.designation,
        staffType: s.staffType ? { id: s.staffType.id, name: s.staffType.name, teaching: isTeachingType(s.staffType) } : null,
        employmentType: s.employmentType,
        teachingPost: s.teachingPost,
        reportsTo: s.reportsTo ? { id: s.reportsTo.id, name: staffName(s.reportsTo), code: s.reportsTo.employeeCode } : null,
        teachableSubjectIds: s.teachableSubjectIds,
        custom: await visibleValues('staff', s.customFields, viewer.userId),
        bank: s.bank,
        bankAccountNo: mask(s.bankAccountNo, show),
        ifsc: s.ifsc,
        pfNumber: mask(s.pfNumber, show),
        uan: s.uan,
        emergencyName: s.emergencyName,
        emergencyPhone: s.emergencyPhone,
        photoUrl: s.photoFileId ? `staff/${s.id}/photo?v=${s.photoFileId}` : null,
        status: s.status,
        statusDate: dayOf(s.statusDate),
        relievingReason: s.relievingReason,
        statusNote: s.statusNote,
        login: s.user ? { id: s.user.id, username: s.user.username, status: s.user.status, lastLoginAt: s.user.lastLoginAt, roles: s.user.roles.map((r) => r.role) } : null,
        sensitiveShown: show,
        qualifications: s.qualifications.map((q) => ({ id: q.id, qualification: q.qualification, subject: q.subject, institution: q.institution, year: q.year })),
        experience: s.experience.map((e) => ({ id: e.id, organisation: e.organisation, role: e.role, fromDate: dayOf(e.fromDate), toDate: dayOf(e.toDate) })),
        documents: s.documents.map((d) => ({ id: d.id, type: d.type, note: d.note, fileName: d.file.originalName, mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes, createdAt: d.createdAt })),
        thisYear: {
            classTeacherOf: classTeacherOf.map((c) => ({ id: c.id, label: label(c) })),
            teaches: assignments
                .sort((a, b) => a.section.schoolClass.sortOrder - b.section.schoolClass.sortOrder || a.section.name.localeCompare(b.section.name))
                .map((a) => ({ section: { id: a.section.id, label: label(a.section) }, subject: a.subject })),
        },
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
};

export const getStaff = async (id: string, viewer: Viewer) => {
    await assertVisible(id, viewer);
    return present(await db.staff.findUniqueOrThrow({ where: { id }, include }), viewer);
};

type Filters = ListQuery<typeof staffFilters>['filters'];

export const listStaff = async (q: ListQuery<typeof staffFilters>, viewer: Viewer) => {
    const f: Filters = q.filters;
    const search = q.search?.trim();
    const where: Prisma.StaffWhereInput = {
        ...scopeWhere(viewer),
        status: f.status ?? 'working',
        ...(f.department ? { departmentId: f.department } : {}),
        ...(f.designation ? { designationId: f.designation } : {}),
        ...(f.type ? { staffTypeId: f.type } : {}),
        ...(search
            ? {
                  OR: [
                      { firstName: { contains: search, mode: 'insensitive' } },
                      { lastName: { contains: search, mode: 'insensitive' } },
                      { employeeCode: { contains: search, mode: 'insensitive' } },
                      { mobile: { contains: search.replace(/\D/g, '') || search } },
                  ],
              }
            : {}),
    };
    const orderBy: Prisma.StaffOrderByWithRelationInput[] =
        q.sort === 'code' ? [{ employeeCode: q.order }] : q.sort === 'joiningDate' ? [{ joiningDate: q.order }] : [{ firstName: q.order }, { lastName: q.order }];
    const [rows, total] = await Promise.all([
        db.staff.findMany({ where, orderBy, skip: q.skip, take: q.take, include: { department: ref, designation: ref, staffType: ref, user: { select: { id: true, status: true } } } }),
        db.staff.count({ where }),
    ]);
    return listResult(
        rows.map((s) => ({
            id: s.id,
            employeeCode: s.employeeCode,
            name: staffName(s),
            department: s.department,
            designation: s.designation,
            staffType: s.staffType,
            mobile: s.mobile,
            status: s.status,
            canSignIn: !!s.user && s.user.status === 'active',
            photoUrl: s.photoFileId ? `staff/${s.id}/photo?v=${s.photoFileId}` : null,
        })),
        total,
        q
    );
};

/** Working staff for dropdowns (class teacher, subject teacher, reports to…). */
export const staffOptions = async (opts: { teaching?: boolean } = {}) => {
    const rows = await db.staff.findMany({
        where: { status: 'working', ...(opts.teaching ? { staffType: { extra: { path: ['teaching'], equals: true } } } : {}) },
        select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true, designation: { select: { name: true } }, teachableSubjectIds: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, name: staffName(r), code: r.employeeCode, designation: r.designation?.name ?? null, teachableSubjectIds: r.teachableSubjectIds }));
};

// ─── Qualifications and experience ───────────────────────────────────────────

export const qualificationsSchema = z.array(
    z.strictObject({
        qualificationId: id,
        subject: text(120),
        institution: text(150),
        year: z.number().int().min(1950, 'is too early').max(2100).nullable().optional(),
    })
).max(20);
export const experienceSchema = z.array(
    z.strictObject({
        organisation: z.string().trim().min(1, 'is required').max(150),
        role: text(120),
        fromDate: day.nullable().optional(),
        toDate: day.nullable().optional(),
    })
).max(20);

const saveQualifications = async (staffId: string, list: z.infer<typeof qualificationsSchema>, client: typeof db | Tx) => {
    const tenantId = getTenantId()!;
    for (const q of list) {
        if (q.qualificationId && !(await client.masterValue.findFirst({ where: { id: q.qualificationId, master: 'qualification' } }))) throw badRequest('Choose a qualification from the list');
    }
    await client.staffQualification.deleteMany({ where: { staffId } });
    if (list.length) await client.staffQualification.createMany({ data: list.map((q, i) => ({ tenantId, staffId, qualificationId: q.qualificationId ?? null, subject: q.subject ?? null, institution: q.institution ?? null, year: q.year ?? null, sortOrder: (i + 1) * 10 })) });
};

const saveExperience = async (staffId: string, list: z.infer<typeof experienceSchema>, client: typeof db | Tx) => {
    const tenantId = getTenantId()!;
    for (const e of list) if (e.fromDate && e.toDate && e.toDate < e.fromDate) throw badRequest(`${e.organisation}: the end date is before the start date`);
    await client.staffExperience.deleteMany({ where: { staffId } });
    if (list.length) {
        await client.staffExperience.createMany({
            data: list.map((e, i) => ({ tenantId, staffId, organisation: e.organisation, role: e.role ?? null, fromDate: e.fromDate ? toDate(e.fromDate) : null, toDate: e.toDate ? toDate(e.toDate) : null, sortOrder: (i + 1) * 10 })),
        });
    }
};

export const setQualifications = async (staffId: string, list: z.infer<typeof qualificationsSchema>, viewer: Viewer) => {
    await assertVisible(staffId, viewer);
    await withTransaction((tx) => saveQualifications(staffId, list, tx));
    await recordAudit({ action: 'qualifications_change', entity: 'staff', entityId: staffId, changes: { qualifications: list.length } });
    return getStaff(staffId, viewer);
};

export const setExperience = async (staffId: string, list: z.infer<typeof experienceSchema>, viewer: Viewer) => {
    await assertVisible(staffId, viewer);
    await withTransaction((tx) => saveExperience(staffId, list, tx));
    await recordAudit({ action: 'experience_change', entity: 'staff', entityId: staffId, changes: { entries: list.length } });
    return getStaff(staffId, viewer);
};

// ─── Adding, changing ────────────────────────────────────────────────────────

export const createStaffSchema = z.strictObject({
    staff: staffFieldsSchema,
    qualifications: qualificationsSchema.optional(),
    experience: experienceSchema.optional(),
    /** "Can sign in": a login is made now, with these roles (empty = the default role for staff). */
    login: z.strictObject({ enabled: z.boolean(), roleIds: z.array(z.uuid()).max(10).optional() }).optional(),
});

const loginFor = async (staffId: string, roleIds: string[] | undefined, client: typeof db | Tx) => {
    const s = await client.staff.findUniqueOrThrow({ where: { id: staffId } });
    if (s.userId) throw conflict('This staff member already has a login');
    const { byName } = await getSettings({ byName: STAFF.username }).then((x) => ({ byName: x.byName === 'name' }));
    const roles = roleIds?.length ? await client.role.findMany({ where: { id: { in: roleIds } }, select: { slug: true, isSystem: true } }) : [];
    if (roles.some((r) => r.isSystem)) throw forbidden('The Super Admin role is given on the Users screen');
    const code = s.employeeCode.replace(/[^A-Za-z0-9]/g, '');
    const login = await createLogin(
        {
            kind: 'staff',
            displayName: staffName(s),
            email: s.email,
            mobile: s.mobile,
            usernameCandidates: byName ? [`${s.firstName} ${s.lastName ?? ''}`.trim(), code] : [code, staffName(s)],
            dateOfBirth: s.dateOfBirth,
            ...(roles.length ? { roleSlugs: roles.map((r) => r.slug) } : {}),
        },
        client
    );
    await client.staff.update({ where: { id: staffId }, data: { userId: login.user.id } });
    return login;
};

export const createStaff = async (input: z.infer<typeof createStaffSchema>, viewer: Viewer) => {
    const s = await getSettings({ required: STAFF.requiredFields, hidden: STAFF.hiddenFields, editable: STAFF.codeEditable });
    const fields = withoutHidden(input.staff, s.hidden);
    await checkFields(fields, s.required);
    const customFields = (await checkCustom('staff', input.staff.custom, null, true, viewer.userId)) ?? {};
    if (fields.employeeCode && !s.editable) throw badRequest('Employee codes are given automatically', [{ field: 'employeeCode', message: 'is given automatically' }]);
    await uniqueChecks(fields);
    const joiningDate = fields.joiningDate ? toDate(fields.joiningDate) : toDate(new Date().toISOString().slice(0, 10));
    const employeeCode = fields.employeeCode ?? (await allocateEmployeeCode(joiningDate));
    const tenantId = getTenantId()!;
    let welcome: Awaited<ReturnType<typeof loginFor>> | null = null;
    const created = await withTransaction(
        async (tx) => {
            const row = await tx.staff.create({ data: { tenantId, ...dbFields(fields), firstName: fields.firstName, employeeCode, joiningDate, customFields: customFields as Prisma.InputJsonValue } as Prisma.StaffUncheckedCreateInput });
            if (input.qualifications?.length) await saveQualifications(row.id, input.qualifications, tx);
            if (input.experience?.length) await saveExperience(row.id, input.experience, tx);
            if (input.login?.enabled) welcome = await loginFor(row.id, input.login.roleIds, tx);
            return row;
        },
        { timeout: 60_000 }
    );
    const login = welcome as Awaited<ReturnType<typeof loginFor>> | null;
    if (login) await sendWelcomeEmail(login);
    await recordAudit({ action: 'create', entity: 'staff', entityId: created.id, changes: { employeeCode, name: staffName(created) } });
    return {
        staff: await getStaff(created.id, { ...viewer, scope: 'all' }),
        login: login ? { for: staffName(created), username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome } : null,
    };
};

export const updateStaff = async (id: string, input: StaffFields, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const current = await db.staff.findUniqueOrThrow({ where: { id } });
    const s = await getSettings({ required: STAFF.requiredFields, hidden: STAFF.hiddenFields, editable: STAFF.codeEditable });
    const fields = withoutHidden(input, s.hidden);
    if (fields.employeeCode !== undefined && fields.employeeCode !== current.employeeCode && !s.editable) throw badRequest('Employee codes are given automatically');
    if (fields.employeeCode === null) throw badRequest('Employee code is required', [{ field: 'employeeCode', message: 'is required' }]);
    if (!viewer.sensitive) for (const k of SENSITIVE) delete fields[k];
    const merged = { ...current, dateOfBirth: dayOf(current.dateOfBirth), joiningDate: dayOf(current.joiningDate) ?? undefined, ...fields } as unknown as StaffFields;
    await checkFields(merged, s.required, id);
    await uniqueChecks(fields, id);
    const customFields = await checkCustom('staff', input.custom, current.customFields, false, viewer.userId);
    await db.staff.update({ where: { id }, data: { ...dbFields(fields), ...(customFields ? { customFields: customFields as Prisma.InputJsonValue } : {}) } as Prisma.StaffUpdateInput });
    return getStaff(id, viewer);
};

export const statusSchema = z.strictObject({
    status: z.enum(['working', 'relieved', 'retired', 'suspended']),
    date: day.optional(),
    relievingReasonId: z.uuid().nullable().optional(),
    note: text(300),
});

/** Leaving (or a suspension) switches the login off; coming back switches it on again. */
export const setStatus = async (id: string, input: z.infer<typeof statusSchema>, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const s = await db.staff.findUniqueOrThrow({ where: { id } });
    if (input.relievingReasonId && !(await db.masterValue.findFirst({ where: { id: input.relievingReasonId, master: 'relieving_reason' } }))) throw badRequest('Choose a reason from the list');
    const working = input.status === 'working';
    await db.staff.update({
        where: { id },
        data: {
            status: input.status as StaffStatus,
            statusDate: working ? null : toDate(input.date ?? new Date().toISOString().slice(0, 10)),
            relievingReasonId: working ? null : input.relievingReasonId ?? null,
            statusNote: working ? null : input.note ?? null,
        },
    });
    if (s.userId) {
        await db.user.update({ where: { id: s.userId }, data: { status: working ? 'active' : 'disabled' } });
        if (!working) await revokeUserSessions(s.userId, 'admin');
    }
    return getStaff(id, viewer);
};

export const addStaffLogin = async (id: string, roleIds: string[] | undefined, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const login = await withTransaction((tx) => loginFor(id, roleIds, tx));
    await sendWelcomeEmail(login);
    return { username: login.user.username, temporaryPassword: login.temporaryPassword, emailed: !!login.welcome };
};

// ─── My own record ───────────────────────────────────────────────────────────

const SELF_COLUMNS: Record<SelfEditField, string[]> = {
    mobile: ['mobile'],
    email: ['email'],
    address: ['addressLine', 'stateId', 'districtId', 'cityId', 'pinCode'],
    emergency: ['emergencyName', 'emergencyPhone'],
    bank: ['bankId', 'bankAccountNo', 'ifsc'],
    qualifications: [],
    custom: ['custom'],
};

export const myStaff = async (userId: string) => {
    const s = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!s) return null;
    const { selfEdit } = await getSettings({ selfEdit: STAFF.selfEdit });
    return { record: await getStaff(s.id, { userId, scope: 'own', sensitive: false }), selfEdit };
};

/** What staff may change themselves (System Settings → Staff → "Staff can change these"). */
export const updateMyStaff = async (userId: string, input: StaffFields & { qualifications?: z.infer<typeof qualificationsSchema>; experience?: z.infer<typeof experienceSchema> }) => {
    const s = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!s) throw notFound('Your login is not linked to a staff record');
    const { selfEdit } = await getSettings({ selfEdit: STAFF.selfEdit });
    const allowed = new Set(selfEdit.flatMap((f) => SELF_COLUMNS[f]));
    const { qualifications, experience, ...fields } = input;
    const blocked = Object.keys(fields).filter((k) => !allowed.has(k));
    if (blocked.length) throw forbidden(`The school office manages ${blocked.join(', ')}. Ask them to change it.`);
    if ((qualifications || experience) && !selfEdit.includes('qualifications')) throw forbidden('The school office manages qualifications and experience');
    const viewer: Viewer = { userId, scope: 'own', sensitive: true };
    if (Object.keys(fields).length) await updateStaff(s.id, fields, viewer);
    if (qualifications) await setQualifications(s.id, qualifications, viewer);
    if (experience) await setExperience(s.id, experience, viewer);
    return myStaff(userId);
};

export const formConfig = async (userId?: string) => ({
    ...(await getSettings({ required: STAFF.requiredFields, hidden: STAFF.hiddenFields, editable: STAFF.codeEditable, loginDefault: STAFF.loginDefault, selfEdit: STAFF.selfEdit })),
    ...(await formExtras('staff', userId)),
});
