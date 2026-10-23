import { Prisma } from '@prisma/client';
import { classesOfYear, runsIn } from '../academic/year-classes.service';
import { requireCode } from '../masters/coded-lists';
import { counterMode } from '../fees/payment-modes';
import { testResults } from './test-results';
import { z } from 'zod';
import { db, withTransaction, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { formatNumber, peekNumber, takeNumbers } from '../../core/numbering';
import { ListQuery, listResult } from '../../core/http/list-query';
/** One family, one number: digits only, without the India +91 / leading 0 (so 098765… and +91 98765… match). */
const normalizeMobile = (raw: string) => {
    const d = raw.replace(/\D/g, '');
    return d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
};
import { currentYear } from '../academic/years.service';
import { ADMISSIONS } from './admissions.settings';
import type { enquiryFilters } from './admissions.schemas';
import { alertEnquiryAssigned } from './admissions.alerts';

/** Admission enquiries: from first call to admitted (converted into a student) or lost. */

// ─── Who is looking ──────────────────────────────────────────────────────────

export interface Viewer {
    userId: string;
    /** all = every enquiry; own = those assigned to the viewer (their staff record). */
    scope: 'all' | 'assigned' | 'own';
}

const scopeWhere = (v: Viewer): Prisma.EnquiryWhereInput => (v.scope === 'all' ? {} : { assignedTo: { userId: v.userId } });

const assertVisible = async (id: string, viewer: Viewer) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Enquiry not found');
    const e = await db.enquiry.findFirst({ where: { id, ...scopeWhere(viewer) } });
    if (!e) throw notFound('Enquiry not found');
    return e;
};

// ─── Stages (master "enquiry_stage") ─────────────────────────────────────────

export interface Stage {
    id: string;
    name: string;
    won: boolean;
    lost: boolean;
    isActive: boolean;
}

export const listStages = async (client: typeof db | Tx = db): Promise<Stage[]> =>
    (await client.masterValue.findMany({ where: { master: 'enquiry_stage' }, select: { id: true, name: true, extra: true, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((v) => ({
        id: v.id,
        name: v.name,
        won: !!(v.extra as { won?: boolean }).won,
        lost: !!(v.extra as { lost?: boolean }).lost,
        isActive: v.isActive,
    }));

const isOpen = (s: Stage) => !s.won && !s.lost;
const stageNeeded = (what: string) => badRequest(`Set up the enquiry stages first: Configuration → Masters → Enquiry stages needs ${what}`);
const firstOpen = (stages: Stage[]) => stages.find((s) => s.isActive && isOpen(s)) ?? (() => { throw stageNeeded('an open stage (neither Won nor Lost)'); })();
const wonStage = (stages: Stage[]) => stages.find((s) => s.isActive && s.won) ?? stages.find((s) => s.won) ?? (() => { throw stageNeeded('a stage marked Won (admitted)'); })();
const openStageIds = (stages: Stage[]) => stages.filter(isOpen).map((s) => s.id);

// ─── Fields ──────────────────────────────────────────────────────────────────

const text = (max: number) =>
    z
        .union([z.literal('').transform(() => null), z.string().trim().max(max, `must be at most ${max} characters`), z.null()])
        .optional();
const id = z.uuid('choose one from the list').nullable().optional();
const day = z.iso.date('must be a date like 2026-04-15');
const mobile = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid phone number');
const email = z.union([z.literal('').transform(() => null), z.string().trim().toLowerCase().email('is not a valid email'), z.null()]).optional();

export const enquiryFieldsSchema = z.strictObject({
    enquiryDate: day.optional(),
    academicYearId: z.uuid('choose an academic year').optional(),
    classId: z.uuid('choose the class'),
    studentFirstName: z.string().trim().min(1, 'is required').max(80, 'must be at most 80 characters'),
    studentLastName: text(80),
    dateOfBirth: day.nullable().optional(),
    genderId: id,
    parentName: z.string().trim().min(1, 'is required').max(120, 'must be at most 120 characters'),
    relationId: id,
    mobile,
    email,
    area: text(120),
    currentSchool: text(150),
    sourceId: id,
    assignedToId: id,
    nextFollowUp: day.nullable().optional(),
    remarks: text(1000),
});
export const enquiryCreateSchema = enquiryFieldsSchema.extend({ stageId: z.uuid().optional() });
export const enquiryUpdateSchema = enquiryFieldsSchema.partial();
type EnquiryFields = z.infer<typeof enquiryUpdateSchema>;

const MASTER_OF: Record<string, string> = {
    genderId: 'gender',
    relationId: 'relation',
    sourceId: 'enquiry_source',
};

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(toDate(d).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Wrong options, a class / year / staff member that doesn't exist. */
const checkFields = async (f: EnquiryFields) => {
    const issues: { field: string; message: string }[] = [];
    const ids = Object.entries(MASTER_OF).flatMap(([field, master]) => ((f as Record<string, unknown>)[field] ? [{ field, master, id: (f as Record<string, string>)[field] }] : []));
    if (ids.length) {
        const rows = await db.masterValue.findMany({ where: { id: { in: ids.map((i) => i.id) } }, select: { id: true, master: true } });
        const byId = new Map(rows.map((r) => [r.id, r.master]));
        for (const i of ids) if (byId.get(i.id) !== i.master) issues.push({ field: i.field, message: 'is not an option of its list' });
    }
    if (f.classId && !(await db.schoolClass.findFirst({ where: { id: f.classId, isActive: true }, select: { id: true } }))) issues.push({ field: 'classId', message: 'was not found' });
    else if (f.classId && f.academicYearId && !(await runsIn(f.academicYearId, f.classId))) issues.push({ field: 'classId', message: 'is not a class of that session' });
    if (f.academicYearId && !(await db.academicYear.findUnique({ where: { id: f.academicYearId }, select: { id: true } }))) issues.push({ field: 'academicYearId', message: 'was not found' });
    if (f.assignedToId && !(await db.staff.findFirst({ where: { id: f.assignedToId, status: 'working' }, select: { id: true } }))) issues.push({ field: 'assignedToId', message: 'is not a working staff member' });
    if (f.dateOfBirth && f.dateOfBirth > today()) issues.push({ field: 'dateOfBirth', message: 'is in the future' });
    if (f.enquiryDate && f.enquiryDate > today()) issues.push({ field: 'enquiryDate', message: 'is in the future' });
    if (issues.length) throw badRequest(issues.length === 1 ? `${issues[0].field} ${issues[0].message}` : 'Some fields need attention', issues);
};

const dbFields = (f: EnquiryFields) => ({
    ...f,
    ...(f.mobile ? { mobile: normalizeMobile(f.mobile) } : {}),
    ...(f.enquiryDate ? { enquiryDate: toDate(f.enquiryDate) } : {}),
    ...(f.dateOfBirth !== undefined ? { dateOfBirth: f.dateOfBirth ? toDate(f.dateOfBirth) : null } : {}),
    ...(f.nextFollowUp !== undefined ? { nextFollowUp: f.nextFollowUp ? toDate(f.nextFollowUp) : null } : {}),
});

// ─── Numbers ─────────────────────────────────────────────────────────────────

const enquiryKey = (date: Date) => `enquiry:${date.getUTCFullYear()}`;
const registrationKey = (date: Date) => `registration:${date.getUTCFullYear()}`;
const hasYear = (pattern: string) => /\{YY(YY)?\}/.test(pattern);

const allocate = async (kind: 'enquiry' | 'registration', date: Date) => {
    const s = await getSettings({ pattern: kind === 'enquiry' ? ADMISSIONS.enquiryPattern : ADMISSIONS.registrationPattern });
    // A pattern with the year starts again every year; without it the number keeps counting.
    const key = hasYear(s.pattern) ? (kind === 'enquiry' ? enquiryKey(date) : registrationKey(date)) : kind;
    for (let attempt = 0; attempt < 20; attempt++) {
        const no = formatNumber(s.pattern, { seq: await takeNumbers(key, 1), date });
        const column = kind === 'enquiry' ? 'enquiryNo' : 'registrationNo';
        if (!(await db.enquiry.findFirst({ where: { [column]: { equals: no, mode: 'insensitive' } }, select: { id: true } }))) return no;
    }
    throw conflict(`Could not find a free ${kind} number; check the pattern in System Settings → Admissions`);
};

export const previewNumbers = async () => {
    const s = await getSettings({ enquiry: ADMISSIONS.enquiryPattern, registration: ADMISSIONS.registrationPattern });
    const date = new Date();
    return {
        enquiryNo: formatNumber(s.enquiry, { seq: await peekNumber(hasYear(s.enquiry) ? enquiryKey(date) : 'enquiry', 1), date }),
        registrationNo: formatNumber(s.registration, { seq: await peekNumber(hasYear(s.registration) ? registrationKey(date) : 'registration', 1), date }),
    };
};

// ─── Reading ─────────────────────────────────────────────────────────────────

const named = { select: { id: true, name: true } } as const;
const listInclude = {
    schoolClass: { select: { id: true, name: true, shortName: true } },
    academicYear: named,
    source: named,
    stage: { select: { id: true, name: true, extra: true } },
    assignedTo: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
} satisfies Prisma.EnquiryInclude;

const staffName = (s: { firstName: string; lastName: string | null } | null) => (s ? [s.firstName, s.lastName].filter(Boolean).join(' ') : null);

type ListRow = Prisma.EnquiryGetPayload<{ include: typeof listInclude }>;
const followUpState = (e: { nextFollowUp: Date | null }, open: boolean) => {
    if (!open || !e.nextFollowUp) return null;
    const d = dayOf(e.nextFollowUp)!;
    return d < today() ? 'overdue' : d === today() ? 'today' : 'upcoming';
};
const presentRow = (e: ListRow) => {
    const extra = e.stage.extra as { won?: boolean; lost?: boolean };
    const status = extra.won ? 'won' : extra.lost ? 'lost' : 'open';
    return {
        id: e.id,
        enquiryNo: e.enquiryNo,
        enquiryDate: dayOf(e.enquiryDate),
        studentName: [e.studentFirstName, e.studentLastName].filter(Boolean).join(' '),
        parentName: e.parentName,
        mobile: e.mobile,
        class: e.schoolClass,
        academicYear: e.academicYear,
        source: e.source,
        stage: { id: e.stage.id, name: e.stage.name },
        status,
        assignedTo: e.assignedTo ? { id: e.assignedTo.id, name: staffName(e.assignedTo), employeeCode: e.assignedTo.employeeCode } : null,
        nextFollowUp: dayOf(e.nextFollowUp),
        followUp: followUpState(e, status === 'open'),
        registrationNo: e.registrationNo,
        testResult: e.testResult,
        online: e.online,
        studentId: e.studentId,
    };
};

const listWhere = async (q: Pick<ListQuery<typeof enquiryFilters>, 'filters' | 'search'>, viewer: Viewer): Promise<Prisma.EnquiryWhereInput> => {
    const f = q.filters;
    const and: Prisma.EnquiryWhereInput[] = [scopeWhere(viewer)];
    if (f.year) and.push({ academicYearId: f.year });
    if (f.class) and.push({ classId: f.class });
    if (f.stage) and.push({ stageId: f.stage });
    if (f.source) and.push({ sourceId: f.source });
    if (f.assigned === 'none') and.push({ assignedToId: null });
    else if (f.assigned) and.push({ assignedToId: f.assigned });
    if (f.online !== undefined) and.push({ online: f.online === 'yes' });
    if (f.from) and.push({ enquiryDate: { gte: toDate(f.from) } });
    if (f.to) and.push({ enquiryDate: { lte: toDate(f.to) } });
    if (f.status || f.due) {
        const stages = await listStages();
        const pick = (p: (s: Stage) => boolean) => stages.filter(p).map((s) => s.id);
        const status = f.due ? 'open' : f.status;
        and.push({ stageId: { in: status === 'won' ? pick((s) => s.won) : status === 'lost' ? pick((s) => s.lost) : pick(isOpen) } });
    }
    if (f.due === 'overdue') and.push({ nextFollowUp: { lt: toDate(today()) } });
    if (f.due === 'today') and.push({ nextFollowUp: toDate(today()) });
    if (f.due === 'upcoming') and.push({ nextFollowUp: { gt: toDate(today()) } });
    if (f.due === 'none') and.push({ nextFollowUp: null });
    if (q.search) {
        const s = q.search;
        const digits = s.replace(/\D/g, '');
        and.push({
            OR: [
                { studentFirstName: { contains: s, mode: 'insensitive' } },
                { studentLastName: { contains: s, mode: 'insensitive' } },
                { parentName: { contains: s, mode: 'insensitive' } },
                { enquiryNo: { contains: s, mode: 'insensitive' } },
                { registrationNo: { contains: s, mode: 'insensitive' } },
                ...(digits.length >= 4 ? [{ mobile: { contains: digits } }] : []),
            ],
        });
    }
    return { AND: and };
};

const ORDER: Record<string, (o: 'asc' | 'desc') => Prisma.EnquiryOrderByWithRelationInput[]> = {
    enquiryDate: (o) => [{ enquiryDate: o }, { createdAt: o }],
    nextFollowUp: (o) => [{ nextFollowUp: { sort: o, nulls: 'last' } }, { enquiryDate: 'desc' }],
    studentName: (o) => [{ studentFirstName: o }, { studentLastName: o }],
    enquiryNo: (o) => [{ enquiryNo: o }],
};

export const listEnquiries = async (q: ListQuery<typeof enquiryFilters>, viewer: Viewer) => {
    const where = await listWhere(q, viewer);
    const [rows, total] = await Promise.all([
        db.enquiry.findMany({ where, include: listInclude, orderBy: ORDER[q.sort](q.order), skip: q.skip, take: q.take }),
        db.enquiry.count({ where }),
    ]);
    return listResult(rows.map(presentRow), total, q);
};

/** Counts per stage and follow-ups due, for the top of the enquiry list. */
export const enquirySummary = async (yearId: string | undefined, viewer: Viewer) => {
    const base: Prisma.EnquiryWhereInput = { ...scopeWhere(viewer), ...(yearId ? { academicYearId: yearId } : {}) };
    const stages = await listStages();
    const open = openStageIds(stages);
    const byStage = await db.enquiry.groupBy({ by: ['stageId'], where: base, _count: { _all: true } });
    const count = new Map(byStage.map((r) => [r.stageId, r._count._all]));
    const [overdue, dueToday] = await Promise.all([
        db.enquiry.count({ where: { ...base, stageId: { in: open }, nextFollowUp: { lt: toDate(today()) } } }),
        db.enquiry.count({ where: { ...base, stageId: { in: open }, nextFollowUp: toDate(today()) } }),
    ]);
    const total = [...count.values()].reduce((a, b) => a + b, 0);
    const won = stages.filter((s) => s.won).reduce((a, s) => a + (count.get(s.id) ?? 0), 0);
    const lost = stages.filter((s) => s.lost).reduce((a, s) => a + (count.get(s.id) ?? 0), 0);
    return {
        total,
        open: total - won - lost,
        won,
        lost,
        overdue,
        dueToday,
        stages: stages.filter((s) => s.isActive || count.get(s.id)).map((s) => ({ ...s, count: count.get(s.id) ?? 0 })),
    };
};

export const getEnquiry = async (id: string, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const e = await db.enquiry.findUniqueOrThrow({
        where: { id },
        include: {
            ...listInclude,
            gender: named,
            relation: named,
            lostReason: named,
            student: { select: { id: true, admissionNo: true, firstName: true, lastName: true } },
            followUps: { include: { outcome: named }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] },
        },
    });
    const creators = [...new Set(e.followUps.map((f) => f.createdBy).filter((x): x is string => !!x))];
    const users = creators.length ? await db.user.findMany({ where: { id: { in: creators } }, select: { id: true, displayName: true } }) : [];
    const userName = new Map(users.map((u) => [u.id, u.displayName]));
    return {
        ...presentRow(e),
        studentFirstName: e.studentFirstName,
        studentLastName: e.studentLastName,
        dateOfBirth: dayOf(e.dateOfBirth),
        gender: e.gender,
        relation: e.relation,
        email: e.email,
        area: e.area,
        currentSchool: e.currentSchool,
        remarks: e.remarks,
        lostReason: e.lostReason,
        registrationDate: dayOf(e.registrationDate),
        registrationFee: e.registrationFee,
        registrationFeeMode: e.registrationFeeMode,
        registrationFeeRef: e.registrationFeeRef,
        testDate: dayOf(e.testDate),
        testScore: e.testScore,
        student: e.student ? { id: e.student.id, admissionNo: e.student.admissionNo, name: [e.student.firstName, e.student.lastName].filter(Boolean).join(' ') } : null,
        convertedAt: e.convertedAt,
        createdAt: e.createdAt,
        followUps: e.followUps.map((f) => ({
            id: f.id,
            date: dayOf(f.date),
            outcome: f.outcome,
            note: f.note,
            nextDate: dayOf(f.nextDate),
            by: f.createdBy ? userName.get(f.createdBy) ?? null : null,
            createdAt: f.createdAt,
        })),
    };
};

/** Settings and choices the enquiry screens need. */
export const formConfig = async () => {
    const s = await getSettings({
        registration: ADMISSIONS.registrationEnabled,
        registrationFee: ADMISSIONS.registrationFee,
        test: ADMISSIONS.testEnabled,
        followUpDays: ADMISSIONS.followUpDays,
        publicForm: ADMISSIONS.publicForm,
        duplicateCheck: ADMISSIONS.duplicateCheck,
    });
    return { ...s, stages: await listStages(), numbers: await previewNumbers() };
};

// ─── Creating and changing ───────────────────────────────────────────────────

/** Open enquiries for the same mobile number and class this year (one family asking twice). */
const findDuplicates = async (mobileNo: string, classId: string, yearId: string, exceptId?: string) => {
    const stages = await listStages();
    return db.enquiry.findMany({
        where: { mobile: mobileNo, classId, academicYearId: yearId, stageId: { in: openStageIds(stages) }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true, enquiryNo: true, studentFirstName: true, studentLastName: true },
        take: 5,
    });
};

const resolveYear = async (yearId: string | undefined) => {
    if (yearId) return yearId;
    const y = await currentYear();
    if (!y) throw badRequest('Choose the academic year (no current year is set in Academic setup)', [{ field: 'academicYearId', message: 'is required' }]);
    return y.id;
};

export const createEnquiry = async (input: z.infer<typeof enquiryCreateSchema>, viewer: Viewer, opts: { online?: boolean } = {}) => {
    await checkFields(input);
    const s = await getSettings({ followUpDays: ADMISSIONS.followUpDays, duplicateCheck: ADMISSIONS.duplicateCheck });
    const stages = await listStages();
    let stageId = firstOpen(stages).id;
    if (input.stageId) {
        const st = stages.find((x) => x.id === input.stageId);
        if (!st || !isOpen(st)) throw badRequest('A new enquiry starts at an open stage', [{ field: 'stageId', message: 'must be an open stage' }]);
        stageId = st.id;
    }
    const academicYearId = await resolveYear(input.academicYearId);
    const mobileNo = normalizeMobile(input.mobile);

    let warning: string | undefined;
    if (s.duplicateCheck !== 'off') {
        const dupes = await findDuplicates(mobileNo, input.classId, academicYearId);
        if (dupes.length) {
            const list = dupes.map((d) => `${d.enquiryNo} (${[d.studentFirstName, d.studentLastName].filter(Boolean).join(' ')})`).join(', ');
            if (s.duplicateCheck === 'block' && !opts.online) throw conflict(`This mobile number already has an open enquiry for this class: ${list}`);
            warning = `This mobile number already has an open enquiry for this class: ${list}`;
        }
    }

    // Someone who only sees their own enquiries is following up the ones they add.
    let assignedToId = input.assignedToId ?? null;
    if (!assignedToId && viewer.scope !== 'all') assignedToId = (await db.staff.findFirst({ where: { userId: viewer.userId }, select: { id: true } }))?.id ?? null;

    const enquiryDate = input.enquiryDate ?? today();
    const { stageId: _s, ...fields } = input;
    const enquiryNo = await allocate('enquiry', toDate(enquiryDate));
    const e = await db.enquiry.create({
        data: {
            tenantId: getTenantId()!,
            ...dbFields({ ...fields, enquiryDate, nextFollowUp: input.nextFollowUp === undefined ? addDays(enquiryDate, s.followUpDays) : input.nextFollowUp }),
            mobile: mobileNo,
            classId: input.classId,
            studentFirstName: input.studentFirstName,
            parentName: input.parentName,
            academicYearId,
            stageId,
            assignedToId,
            enquiryNo,
            online: !!opts.online,
        } as Prisma.EnquiryUncheckedCreateInput,
    });
    alertEnquiryAssigned(e.id, viewer.userId);
    return { enquiry: await getEnquiry(e.id, { ...viewer, scope: 'all' }), warning };
};

export const updateEnquiry = async (id: string, input: EnquiryFields, viewer: Viewer) => {
    const current = await assertVisible(id, viewer);
    await checkFields(input);
    if (input.mobile || input.classId || input.academicYearId) {
        const s = await getSettings({ duplicateCheck: ADMISSIONS.duplicateCheck });
        if (s.duplicateCheck === 'block') {
            const dupes = await findDuplicates(normalizeMobile(input.mobile ?? current.mobile), input.classId ?? current.classId, input.academicYearId ?? current.academicYearId, id);
            if (dupes.length) throw conflict(`This mobile number already has an open enquiry for this class: ${dupes.map((d) => d.enquiryNo).join(', ')}`);
        }
    }
    await db.enquiry.update({ where: { id }, data: dbFields(input) as Prisma.EnquiryUncheckedUpdateInput });
    if (input.assignedToId && input.assignedToId !== current.assignedToId) alertEnquiryAssigned(id, viewer.userId);
    return getEnquiry(id, viewer);
};

export const deleteEnquiry = async (id: string, viewer: Viewer) => {
    const e = await assertVisible(id, viewer);
    if (e.studentId) throw conflict('This enquiry became an admission; it is kept with the student');
    await db.enquiry.delete({ where: { id } });
    await recordAudit({ action: 'delete', entity: 'enquiry', entityId: id, changes: { enquiryNo: e.enquiryNo } });
    return { id };
};

// ─── Stage, follow-ups, registration, test ───────────────────────────────────

const stageChange = async (current: { stageId: string; studentId: string | null }, stageId: string, lostReasonId: string | null | undefined, stages: Stage[]) => {
    const to = stages.find((s) => s.id === stageId);
    if (!to) throw badRequest('Choose a stage from the list', [{ field: 'stageId', message: 'is not an enquiry stage' }]);
    if (current.studentId && to.id !== current.stageId) throw conflict('This enquiry is already admitted; its stage can no longer change');
    if (to.won && to.id !== current.stageId) throw badRequest('An enquiry becomes "won" when it is admitted: use Convert to admission', [{ field: 'stageId', message: 'is set by Convert to admission' }]);
    if (to.lost) {
        if (!lostReasonId) throw badRequest('Choose why the enquiry was lost', [{ field: 'lostReasonId', message: 'is required' }]);
        const r = await db.masterValue.findUnique({ where: { id: lostReasonId }, select: { master: true } });
        if (r?.master !== 'enquiry_lost_reason') throw badRequest('Choose a lost reason from the list', [{ field: 'lostReasonId', message: 'is not an option of its list' }]);
    }
    return { stageId: to.id, lostReasonId: to.lost ? lostReasonId! : null, open: isOpen(to) };
};

export const stageSchema = z.strictObject({ stageId: z.uuid('choose a stage'), lostReasonId: id, note: text(1000) });

export const setStage = async (id: string, input: z.infer<typeof stageSchema>, viewer: Viewer) => {
    const current = await assertVisible(id, viewer);
    const change = await stageChange(current, input.stageId, input.lostReasonId, await listStages());
    await withTransaction(async (tx) => {
        await tx.enquiry.update({ where: { id }, data: { stageId: change.stageId, lostReasonId: change.lostReasonId, ...(change.open ? {} : { nextFollowUp: null }) } });
        if (input.note) await tx.enquiryFollowUp.create({ data: { tenantId: current.tenantId, enquiryId: id, date: toDate(today()), note: input.note } });
    });
    return getEnquiry(id, viewer);
};

export const followUpSchema = z.strictObject({
    date: day.optional(),
    outcomeId: id,
    note: text(1000),
    /** When to follow up next; empty = no further follow-up planned. */
    nextDate: day.nullable().optional(),
    /** Move the enquiry on at the same time. */
    stageId: z.uuid().optional(),
    lostReasonId: id,
});

export const addFollowUp = async (id: string, input: z.infer<typeof followUpSchema>, viewer: Viewer) => {
    const current = await assertVisible(id, viewer);
    if (!input.outcomeId && !input.note) throw badRequest('Write what was said, or choose the outcome', [{ field: 'note', message: 'write a note or choose an outcome' }]);
    if (input.outcomeId) {
        const o = await db.masterValue.findUnique({ where: { id: input.outcomeId }, select: { master: true } });
        if (o?.master !== 'follow_up_outcome') throw badRequest('Choose an outcome from the list', [{ field: 'outcomeId', message: 'is not an option of its list' }]);
    }
    const date = input.date ?? today();
    if (date > today()) throw badRequest('A follow-up is recorded after it happened', [{ field: 'date', message: 'is in the future' }]);
    if (input.nextDate && input.nextDate < date) throw badRequest('The next follow-up is before this one', [{ field: 'nextDate', message: 'must be on or after the follow-up date' }]);
    const stages = await listStages();
    const change = input.stageId ? await stageChange(current, input.stageId, input.lostReasonId, stages) : null;
    const open = change ? change.open : isOpen(stages.find((s) => s.id === current.stageId)!);
    await withTransaction(async (tx) => {
        await tx.enquiryFollowUp.create({
            data: { tenantId: current.tenantId, enquiryId: id, date: toDate(date), outcomeId: input.outcomeId ?? null, note: input.note ?? null, nextDate: input.nextDate ? toDate(input.nextDate) : null },
        });
        await tx.enquiry.update({
            where: { id },
            data: {
                nextFollowUp: open && input.nextDate ? toDate(input.nextDate) : null,
                ...(change ? { stageId: change.stageId, lostReasonId: change.lostReasonId } : {}),
            },
        });
    });
    return getEnquiry(id, viewer);
};

export const deleteFollowUp = async (id: string, followUpId: string, viewer: Viewer) => {
    await assertVisible(id, viewer);
    const f = z.uuid().safeParse(followUpId).success ? await db.enquiryFollowUp.findFirst({ where: { id: followUpId, enquiryId: id } }) : null;
    if (!f) throw notFound('Follow-up not found');
    await db.enquiryFollowUp.delete({ where: { id: followUpId } });
    return getEnquiry(id, viewer);
};

export const registerSchema = z.strictObject({
    registrationDate: day.optional(),
    stageId: z.uuid().optional(),
    /** The registration fee received at the counter (System Settings → Admissions → Registration fee). */
    fee: z
        .strictObject({
            amount: z.number().int('whole rupees').min(0).max(100_000),
            /** A payment mode's code (Masters → Payment modes). */
            mode: z.string().trim().min(1).max(20),
            reference: text(60),
        })
        .optional(),
});

type FeePaid = { amount: number; mode: string; reference?: string | null };

/** Gives a registration number (once) and records the registration fee. */
const applyRegistration = async (id: string, date: string, fee: FeePaid | undefined, stageId?: string) => {
    const current = await db.enquiry.findUniqueOrThrow({ where: { id } });
    const registrationNo = current.registrationNo ?? (await allocate('registration', toDate(date)));
    await db.enquiry.update({
        where: { id },
        data: {
            registrationNo,
            registrationDate: current.registrationDate ?? toDate(date),
            ...(stageId ? { stageId } : {}),
            ...(fee ? { registrationFee: fee.amount, registrationFeeMode: fee.mode, registrationFeeRef: fee.reference ?? null } : {}),
        },
    });
    await recordAudit({ action: 'register', entity: 'enquiry', entityId: id, changes: { registrationNo, ...(fee ? { fee: fee.amount, mode: fee.mode } : {}) } });
    return registrationNo;
};

/** Gives the enquiry a registration number (the family filled the registration form / paid the fee). */
export const registerEnquiry = async (id: string, input: z.infer<typeof registerSchema>, viewer: Viewer) => {
    const current = await assertVisible(id, viewer);
    const s = await getSettings({ enabled: ADMISSIONS.registrationEnabled, fee: ADMISSIONS.registrationFee });
    if (!s.enabled) throw badRequest('Registration is switched off (System Settings → Admissions)');
    if (current.registrationNo) throw conflict(`Already registered as ${current.registrationNo}`);
    const date = input.registrationDate ?? today();
    if (date > today()) throw badRequest('The registration date is in the future', [{ field: 'registrationDate', message: 'is in the future' }]);
    if (input.fee && input.fee.amount > 0) {
        const chosen = await counterMode(input.fee.mode, input.fee.reference, 'fee.mode');
        if (chosen.needsReference) throw badRequest(`Enter the ${chosen.mode.name} reference (cheque / transaction number)`, [{ field: 'fee.reference', message: 'is required for this mode' }]);
        input = { ...input, fee: { ...input.fee, mode: chosen.mode.code } };
    }
    const change = input.stageId ? await stageChange(current, input.stageId, null, await listStages()) : null;
    await applyRegistration(id, date, input.fee && input.fee.amount > 0 ? input.fee : undefined, change?.stageId);
    return getEnquiry(id, viewer);
};

/** An online registration fee was paid (the website form): register the enquiry. */
export const registrationPaidOnline = async (id: string, amount: number, paymentRef: string) => {
    await applyRegistration(id, today(), { amount, mode: 'online', reference: paymentRef });
};

export const testSchema = z.strictObject({
    testDate: day.nullable().optional(),
    testScore: text(40),
    /** A test result's code (Masters → Admission test results). */
    testResult: z.string().trim().min(1).max(20),
    stageId: z.uuid().optional(),
});

export const setTest = async (id: string, input: z.infer<typeof testSchema>, viewer: Viewer) => {
    const current = await assertVisible(id, viewer);
    const s = await getSettings({ enabled: ADMISSIONS.testEnabled });
    if (!s.enabled) throw badRequest('The test / interaction step is switched off (System Settings → Admissions)');
    const change = input.stageId ? await stageChange(current, input.stageId, null, await listStages()) : null;
    await db.enquiry.update({
        where: { id },
        data: {
            testResult: requireCode(await testResults(), input.testResult, 'test result', 'testResult').code,
            ...(input.testDate !== undefined ? { testDate: input.testDate ? toDate(input.testDate) : null } : {}),
            ...(input.testScore !== undefined ? { testScore: input.testScore } : {}),
            ...(change ? { stageId: change.stageId } : {}),
        },
    });
    return getEnquiry(id, viewer);
};

// ─── Conversion into a student ───────────────────────────────────────────────

/** What the admission form starts with when an enquiry is converted. */
export const admissionPrefill = async (id: string, viewer: Viewer) => {
    const e = await assertVisible(id, viewer);
    if (e.studentId) throw conflict('This enquiry is already admitted');
    const stages = await listStages();
    if (stages.find((s) => s.id === e.stageId)?.lost) throw conflict('This enquiry was lost; move it back to an open stage first');
    return {
        enquiryId: e.id,
        enquiryNo: e.enquiryNo,
        registrationNo: e.registrationNo,
        academicYearId: e.academicYearId,
        classId: e.classId,
        student: {
            firstName: e.studentFirstName,
            lastName: e.studentLastName,
            dateOfBirth: dayOf(e.dateOfBirth),
            genderId: e.genderId,
            previousSchool: e.currentSchool,
            email: null,
        },
        guardian: { name: e.parentName, relationId: e.relationId, mobile: e.mobile, email: e.email },
    };
};

/** Before an admission from an enquiry: it must exist, be visible and not be admitted or lost. */
export const assertConvertible = async (id: string, viewer: Viewer) => {
    await admissionPrefill(id, viewer);
};

/** Inside the admission's transaction: the enquiry is won and points at its student. */
export const markConverted = async (tx: Tx, enquiryId: string, studentId: string) => {
    const stage = wonStage(await listStages(tx));
    const n = await tx.enquiry.updateMany({ where: { id: enquiryId, studentId: null }, data: { studentId, convertedAt: new Date(), stageId: stage.id, nextFollowUp: null, lostReasonId: null } });
    if (n.count !== 1) throw conflict('This enquiry was admitted at the same moment by someone else');
};

// ─── Website form ────────────────────────────────────────────────────────────

export const publicEnquirySchema = z.strictObject({
    classId: z.uuid('choose the class'),
    studentFirstName: z.string().trim().min(1, 'is required').max(80),
    studentLastName: text(80),
    dateOfBirth: day.nullable().optional(),
    parentName: z.string().trim().min(1, 'is required').max(120),
    mobile,
    email,
    area: text(120),
    currentSchool: text(150),
    message: text(1000),
    /** Left empty by people; bots fill every field. */
    website: z.string().max(200).optional(),
});

export const publicFormInfo = async () => {
    const s = await getSettings({ enabled: ADMISSIONS.publicForm });
    if (!s.enabled) return { enabled: false, classes: [], academicYear: null };
    const year = await currentYear();
    // Only the classes the session runs with admissions open.
    const classes = (await classesOfYear(year?.id, { admissionsOpen: true })).map((c) => ({ id: c.id, name: c.name }));
    return { enabled: true, classes, academicYear: year ? { id: year.id, name: year.name } : null };
};

export const submitPublicEnquiry = async (input: z.infer<typeof publicEnquirySchema>) => {
    const s = await getSettings({ enabled: ADMISSIONS.publicForm });
    if (!s.enabled) throw notFound('The school does not take enquiries online');
    // A bot filled the hidden field: pretend it worked.
    if (input.website) return { enquiryId: null, enquiryNo: null };
    const source = (await db.masterValue.findMany({ where: { master: 'enquiry_source', isActive: true }, select: { id: true, extra: true } })).find((v) => (v.extra as { online?: boolean }).online);
    const { message, website: _w, ...rest } = input;
    const r = await createEnquiry({ ...rest, remarks: message ?? null, sourceId: source?.id ?? null }, { userId: '', scope: 'all' }, { online: true });
    return { enquiryId: r.enquiry.id, enquiryNo: r.enquiry.enquiryNo };
};

// ─── Reports ─────────────────────────────────────────────────────────────────

export const reportSchema = z.object({ year: z.uuid().optional(), from: day.optional(), to: day.optional() });

/** Where enquiries come from, how many become admissions, why the others are lost, seats left. */
export const enquiryReport = async (q: z.infer<typeof reportSchema>, viewer: Viewer) => {
    const yearId = q.year ?? (await currentYear())?.id;
    const where: Prisma.EnquiryWhereInput = {
        ...scopeWhere(viewer),
        ...(yearId ? { academicYearId: yearId } : {}),
        ...(q.from || q.to ? { enquiryDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}),
    };
    const stages = await listStages();
    const won = new Set(stages.filter((s) => s.won).map((s) => s.id));
    const lost = new Set(stages.filter((s) => s.lost).map((s) => s.id));
    const rows = await db.enquiry.findMany({ where, select: { stageId: true, sourceId: true, classId: true, assignedToId: true, lostReasonId: true, enquiryDate: true, online: true } });

    const tally = <K extends string | null>(key: (r: (typeof rows)[number]) => K) => {
        const m = new Map<K, { total: number; won: number; lost: number }>();
        for (const r of rows) {
            const k = key(r);
            const t = m.get(k) ?? { total: 0, won: 0, lost: 0 };
            t.total++;
            if (won.has(r.stageId)) t.won++;
            if (lost.has(r.stageId)) t.lost++;
            m.set(k, t);
        }
        return m;
    };
    const withRate = (t: { total: number; won: number; lost: number }) => ({ ...t, open: t.total - t.won - t.lost, conversion: t.total ? Math.round((t.won / t.total) * 1000) / 10 : 0 });

    const masterIds = [...new Set(rows.flatMap((r) => [r.sourceId, r.lostReasonId]).filter((x): x is string => !!x))];
    const masterName = new Map((await db.masterValue.findMany({ where: { id: { in: masterIds } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
    const staffIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is string => !!x))];
    const staff = new Map((await db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })).map((s) => [s.id, staffName(s)!]));
    const classes = yearId ? (await classesOfYear(yearId)).map((c) => ({ id: c.id, name: c.name })) : await db.schoolClass.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } });

    // Seats: section capacity vs students enrolled, per class (this year).
    const seats = new Map<string, { capacity: number | null; enrolled: number }>();
    if (yearId) {
        const sections = await db.section.findMany({ where: { academicYearId: yearId, isActive: true }, select: { classId: true, capacity: true, _count: { select: { enrolments: true } } } });
        for (const s of sections) {
            const t = seats.get(s.classId) ?? { capacity: 0, enrolled: 0 };
            t.capacity = t.capacity === null || s.capacity === null ? null : t.capacity + s.capacity;
            t.enrolled += s._count.enrolments;
            seats.set(s.classId, t);
        }
    }

    const bySource = tally((r) => r.sourceId);
    const byClass = tally((r) => r.classId);
    const byCounsellor = tally((r) => r.assignedToId);
    const byMonth = tally((r) => r.enquiryDate.toISOString().slice(0, 7));
    const total = withRate([...tally(() => 'all').values()][0] ?? { total: 0, won: 0, lost: 0 });
    const lostReasons = new Map<string | null, number>();
    for (const r of rows) if (lost.has(r.stageId)) lostReasons.set(r.lostReasonId, (lostReasons.get(r.lostReasonId) ?? 0) + 1);

    return {
        academicYearId: yearId ?? null,
        total,
        online: rows.filter((r) => r.online).length,
        stages: stages.map((s) => ({ id: s.id, name: s.name, won: s.won, lost: s.lost, count: rows.filter((r) => r.stageId === s.id).length })).filter((s) => s.count || stages.find((x) => x.id === s.id)!.isActive),
        bySource: [...bySource.entries()].map(([k, t]) => ({ id: k, name: k ? masterName.get(k) ?? '—' : 'Not recorded', ...withRate(t) })).sort((a, b) => b.total - a.total),
        byCounsellor: [...byCounsellor.entries()].map(([k, t]) => ({ id: k, name: k ? staff.get(k) ?? '—' : 'Not assigned', ...withRate(t) })).sort((a, b) => b.total - a.total),
        byMonth: [...byMonth.entries()].map(([month, t]) => ({ month, ...withRate(t) })).sort((a, b) => a.month.localeCompare(b.month)),
        lostReasons: [...lostReasons.entries()].map(([k, count]) => ({ id: k, name: k ? masterName.get(k) ?? '—' : 'Not recorded', count })).sort((a, b) => b.count - a.count),
        byClass: classes.map((c) => {
            const seat = seats.get(c.id);
            return {
                id: c.id,
                name: c.name,
                ...withRate(byClass.get(c.id) ?? { total: 0, won: 0, lost: 0 }),
                capacity: seat?.capacity ?? null,
                enrolled: seat?.enrolled ?? 0,
                seatsLeft: seat?.capacity != null ? Math.max(0, seat.capacity - seat.enrolled) : null,
            };
        }),
    };
};
