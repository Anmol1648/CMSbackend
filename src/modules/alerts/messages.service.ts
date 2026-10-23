import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId, runAsSystem, runAsTenant } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { CHANNELS, Channel } from './alerts.settings';
import { channelsOn, deliver, fill } from './deliver';
import { parentsOf, Recipient, staffOf, studentsOf, usersOf } from './recipients';
import { onQueuePass } from './queue';

/**
 * Messages → Compose: a message to any mix of people, sections, classes, roles, saved groups and
 * typed addresses, on in-app / email / SMS / WhatsApp, now or later. Teachers with the Assigned
 * scope reach only the students and parents of their own sections.
 */

const ids = z.array(z.uuid()).max(500).default([]);
export const audienceSchema = z.strictObject({
    userIds: ids,
    studentIds: ids,
    staffIds: ids,
    sectionIds: ids,
    classIds: ids,
    roleIds: ids,
    groupIds: ids,
    /** For students, sections and classes: their parents, the students, or both. */
    who: z.array(z.enum(['parent', 'student'])).max(2).default(['parent']),
    allStaff: z.boolean().default(false),
    allParents: z.boolean().default(false),
    allStudents: z.boolean().default(false),
    emails: z.array(z.email()).max(50).default([]),
});
export type Audience = z.infer<typeof audienceSchema>;

export const composeSchema = z.strictObject({
    audience: audienceSchema,
    subject: z.string().trim().min(1, 'is required').max(200),
    body: z.string().trim().min(1, 'is required').max(20_000),
    shortText: z.string().trim().max(480).nullable().optional(),
    channels: z.array(z.enum(CHANNELS)).min(1, 'choose at least one').max(4),
    categoryId: z.uuid().nullable().optional(),
    priority: z.string().trim().max(30).default('normal'),
    cc: z.array(z.email()).max(20).default([]),
    attachmentIds: z.array(z.uuid()).max(10).default([]),
    /** Each child's report card: { scope, id } of the result. */
    reportCard: z.strictObject({ scope: z.enum(['exam', 'term', 'final']), id: z.uuid() }).nullable().optional(),
    sendAt: z.coerce.date().nullable().optional(),
});
export type ComposeInput = z.infer<typeof composeSchema>;

/** The sections a teacher may message (class teacher of, or teaches in), this session. */
const ownSections = async (userId: string) => {
    const year = await currentYear();
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!year || !staff) return new Set<string>();
    const [own, teach] = await Promise.all([
        db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id }, select: { id: true } }),
        db.teachingAssignment.findMany({ where: { academicYearId: year.id, staffId: staff.id }, select: { sectionId: true } }),
    ]);
    return new Set([...own.map((s) => s.id), ...teach.map((t) => t.sectionId)]);
};

/** What the sender may do (Roles & Permissions → Messages). */
export const powers = async (userId: string) => {
    const a = await getUserAccess(userId);
    const send = a.permissions['message.send'];
    return {
        send: !!send,
        assigned: send === 'assigned' || send === 'own',
        groups: !!a.permissions['message.send_groups'],
        documents: !!a.permissions['message.attach_documents'],
        schedule: !!a.permissions['message.schedule'],
        paidChannels: !!a.permissions['message.sms_whatsapp'],
        viewSent: a.permissions['message.view_sent'] ?? null,
    };
};

const merge = (a: Audience, b: Partial<Audience>): Audience => {
    const out = { ...a } as Audience;
    for (const k of ['userIds', 'studentIds', 'staffIds', 'sectionIds', 'classIds', 'roleIds', 'emails'] as const) out[k] = [...new Set([...(a[k] as string[]), ...((b[k] as string[] | undefined) ?? [])])] as never;
    out.allStaff ||= !!b.allStaff;
    out.allParents ||= !!b.allParents;
    out.allStudents ||= !!b.allStudents;
    return out;
};

/** Saved groups are opened up into their people and sections. */
const expandGroups = async (a: Audience) => {
    if (!a.groupIds.length) return a;
    const groups = await db.recipientGroup.findMany({ where: { id: { in: a.groupIds } } });
    let out: Audience = { ...a, groupIds: [] };
    for (const g of groups) out = merge(out, audienceSchema.partial().parse(g.audience));
    return out;
};

/** Checks the To line against the sender's permissions. */
const checkAllowed = async (a: Audience, userId: string, p: Awaited<ReturnType<typeof powers>>) => {
    if (!p.send) throw forbidden();
    const wide = a.allStaff || a.allParents || a.allStudents || a.roleIds.length > 0;
    if (wide && !p.groups) throw forbidden('Whole-school groups and roles need “Send to whole-school groups” (Roles & Permissions)');
    if (!p.assigned) return;
    if (a.userIds.length || a.staffIds.length || a.emails.length || a.classIds.length || wide) throw forbidden('You can message the students and parents of your own sections only');
    const mine = await ownSections(userId);
    if (a.sectionIds.some((s) => !mine.has(s))) throw forbidden('You can message your own sections only');
    if (a.studentIds.length) {
        const year = await currentYear();
        const rows = await db.enrolment.findMany({ where: { academicYearId: year?.id, studentId: { in: a.studentIds } }, select: { studentId: true, sectionId: true } });
        if (a.studentIds.some((id) => !rows.some((r) => r.studentId === id && mine.has(r.sectionId)))) throw forbidden('You can message students of your own sections only');
    }
};

type Person = Recipient & { role?: string; sectionIds?: string[]; studentIds?: string[] };

/** The people a To line reaches (once each), with the students they are about (for {{student}}). */
export const resolveAudience = async (raw: Audience) => {
    const a = await expandGroups(raw);
    const year = await currentYear();
    const people: Person[] = [];
    // Students of sections / classes, of the whole school, and the students picked one by one.
    const all = (a.allParents || a.allStudents) && year ? await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { studentId: true, sectionId: true } }) : [];
    const ofGroups =
        (a.sectionIds.length || a.classIds.length) && year
            ? await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' }, OR: [{ sectionId: { in: a.sectionIds } }, { section: { classId: { in: a.classIds } } }] }, select: { studentId: true, sectionId: true } })
            : [];
    const picked = a.studentIds.length && year ? await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: a.studentIds } }, select: { studentId: true, sectionId: true } }) : [];
    const sectionOf = new Map([...all, ...ofGroups, ...picked].map((e) => [e.studentId, e.sectionId]));
    const pick = (whole: boolean, w: 'parent' | 'student') => [...new Set([...(whole ? all : []), ...(a.who.includes(w) ? [...ofGroups, ...picked] : [])].map((e) => e.studentId))];
    const forParents = pick(a.allParents, 'parent');
    const forStudents = pick(a.allStudents, 'student');
    for (const p of await parentsOf(forParents)) people.push({ ...p, role: 'parent', sectionIds: p.studentIds.map((s) => sectionOf.get(s)!).filter(Boolean) });
    for (const p of await studentsOf(forStudents)) people.push({ ...p, role: 'student', sectionIds: p.studentIds.map((s) => sectionOf.get(s)!).filter(Boolean) });
    // Staff: all, by role, picked.
    if (a.allStaff) {
        const staff = await db.staff.findMany({ where: { status: 'working' }, select: { id: true } });
        people.push(...(await staffOf(staff.map((s) => s.id))).map((p) => ({ ...p, role: 'staff' })));
    }
    if (a.roleIds.length) {
        const users = await db.user.findMany({ where: { status: 'active', roles: { some: { roleId: { in: a.roleIds } } } }, select: { id: true } });
        people.push(...(await usersOf(users.map((u) => u.id))).map((p) => ({ ...p, role: 'staff' })));
    }
    if (a.staffIds.length) people.push(...(await staffOf(a.staffIds)).map((p) => ({ ...p, role: 'staff' })));
    if (a.userIds.length) people.push(...(await usersOf(a.userIds)).map((p) => ({ ...p, role: p.kind })));
    for (const e of a.emails) people.push({ userId: null, name: e, email: e, mobile: null, kind: 'other', role: 'other' });
    // The student a parent / student message is about, for {{student}} and {{class}}.
    const allStudentIds = [...new Set(people.flatMap((p) => p.studentIds ?? []))];
    const names = new Map((await db.student.findMany({ where: { id: { in: allStudentIds } }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => [s.id, fullName(s)]));
    const secIds = [...new Set(people.flatMap((p) => p.sectionIds ?? []))];
    const secs = new Map((await db.section.findMany({ where: { id: { in: secIds } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } })).map((s) => [s.id, sectionLabel(s)]));
    return { people, studentName: (p: Person) => (p.studentIds ?? []).map((id) => names.get(id)).filter(Boolean).join(', '), sectionName: (p: Person) => [...new Set((p.sectionIds ?? []).map((id) => secs.get(id)).filter(Boolean))].join(', ') };
};

/** "38 parents of VII-B · All staff · 2 others". */
export const describeAudience = async (a: Audience) => {
    const parts: string[] = [];
    const [secs, classes, roles, groups] = await Promise.all([
        a.sectionIds.length ? db.section.findMany({ where: { id: { in: a.sectionIds } }, select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }) : [],
        a.classIds.length ? db.schoolClass.findMany({ where: { id: { in: a.classIds } }, select: { name: true } }) : [],
        a.roleIds.length ? db.role.findMany({ where: { id: { in: a.roleIds } }, select: { name: true } }) : [],
        a.groupIds.length ? db.recipientGroup.findMany({ where: { id: { in: a.groupIds } }, select: { name: true } }) : [],
    ]);
    const who = a.who.map((w) => (w === 'parent' ? 'parents' : 'students')).join(' & ');
    if (a.allParents) parts.push('All parents');
    if (a.allStudents) parts.push('All students');
    if (a.allStaff) parts.push('All staff');
    if (secs.length || classes.length) parts.push(`${who} of ${[...classes.map((c) => c.name), ...secs.map(sectionLabel)].join(', ')}`);
    if (roles.length) parts.push(roles.map((r) => r.name).join(', '));
    if (groups.length) parts.push(groups.map((g) => g.name).join(', '));
    const loose = a.studentIds.length + a.staffIds.length + a.userIds.length + a.emails.length;
    if (loose) parts.push(`${loose} ${loose === 1 ? 'person' : 'people'}`);
    return parts.join(' · ') || 'Nobody';
};

const schoolName = async () => {
    const s = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } });
    return s?.shortName ?? s?.legalName ?? '';
};

/** Who it will reach and how, before sending. */
export const previewMessage = async (input: ComposeInput, userId: string) => {
    const p = await powers(userId);
    await checkAllowed(input.audience, userId, p);
    const { people, studentName, sectionName } = await resolveAudience(input.audience);
    const on = await channelsOn();
    const chosen = input.channels.filter((c) => on[c]);
    const reach = (c: Channel, r: Recipient) => (c === 'in_app' ? !!r.userId : c === 'email' ? !!r.email : !!r.mobile);
    const unique = new Map(people.map((x) => [x.userId ?? x.email ?? x.mobile ?? x.name, x]));
    const list = [...unique.values()];
    const byKind: Record<string, number> = {};
    for (const x of list) byKind[x.role ?? x.kind] = (byKind[x.role ?? x.kind] ?? 0) + 1;
    const first = list[0];
    const vars: Record<string, string> = first ? { school: await schoolName(), name: first.name, student: studentName(first), class: sectionName(first) } : { school: await schoolName() };
    return {
        people: list.length,
        byKind,
        channels: input.channels.map((c) => ({ channel: c, on: on[c], reach: list.filter((x) => reach(c, x)).length })),
        unreachable: list.filter((x) => !chosen.some((c) => reach(c, x))).length,
        audience: await describeAudience(input.audience),
        sample: first ? { to: first.name, subject: fill(input.subject, vars), body: fill(input.body, vars), shortText: fill(input.shortText || input.body, vars).slice(0, 480) } : null,
    };
};

/** Sends a saved message to its people now. */
const dispatch = async (messageId: string) => {
    const m = await db.message.findFirst({ where: { id: messageId } });
    if (!m || !['scheduled', 'sending'].includes(m.status)) return null;
    await db.message.update({ where: { id: m.id }, data: { status: 'sending' } });
    const audience = audienceSchema.parse(m.audience);
    const { people, studentName, sectionName } = await resolveAudience(audience);
    const card = m.documentKey === 'report_card' ? (m.documentParams as { scope: string; id: string } | null) : null;
    const r = await deliver(
        {
            messageId: m.id,
            type: 'messages',
            subject: m.subject,
            body: m.body,
            shortText: m.shortText,
            vars: { school: await schoolName() },
            perRecipient: (p) => ({ student: studentName(p as Person), class: sectionName(p as Person) }),
            link: '/notifications',
            priority: m.priority,
            channels: m.channels as Channel[],
            required: m.priority !== 'normal',
            attachmentIds: m.attachmentIds,
            documents: card && m.createdBy ? (p) => ((p as Person).studentIds ?? []).map((student) => ({ key: 'report_card', params: { scope: card.scope, id: card.id, student }, asUserId: m.createdBy! })) : null,
            cc: m.cc,
            isDemo: m.isDemo,
        },
        people
    );
    await db.message.update({ where: { id: m.id }, data: { status: 'sent', sentAt: new Date(), recipients: r.people } });
    return r;
};

export const sendMessage = async (input: ComposeInput, userId: string) => {
    const p = await powers(userId);
    await checkAllowed(input.audience, userId, p);
    if ((input.channels.includes('sms') || input.channels.includes('whatsapp')) && !p.paidChannels) throw forbidden('SMS and WhatsApp need “Use SMS and WhatsApp” (Roles & Permissions)');
    if (input.reportCard && !p.documents) throw forbidden('Attaching report cards needs “Attach documents” (Roles & Permissions)');
    const later = input.sendAt && input.sendAt.getTime() > Date.now() + 60_000;
    if (later && !p.schedule) throw forbidden('Scheduling needs “Schedule messages” (Roles & Permissions)');
    if (input.attachmentIds.length) {
        const files = await db.file.count({ where: { id: { in: input.attachmentIds }, uploadedBy: userId } });
        if (files !== input.attachmentIds.length) throw badRequest('Upload the attachments again');
    }
    const m = await db.message.create({
        data: {
            tenantId: getTenantId()!,
            kind: 'compose',
            subject: input.subject,
            body: input.body,
            shortText: input.shortText ?? null,
            channels: input.channels,
            categoryId: input.categoryId ?? null,
            priority: input.priority,
            audience: input.audience as Prisma.InputJsonValue,
            audienceLabel: await describeAudience(input.audience),
            cc: input.cc,
            attachmentIds: input.attachmentIds,
            documentKey: input.reportCard ? 'report_card' : null,
            documentParams: input.reportCard ? (input.reportCard as Prisma.InputJsonValue) : Prisma.DbNull,
            status: later ? 'scheduled' : 'sending',
            sendAt: later ? input.sendAt! : new Date(),
            createdBy: userId,
        },
    });
    await recordAudit({ action: later ? 'message_scheduled' : 'message_sent', entity: 'message', entityId: m.id, changes: { subject: input.subject, to: m.audienceLabel, channels: input.channels.join(', ') } });
    if (!later) await dispatch(m.id);
    return getMessage(m.id, userId);
};

export const cancelMessage = async (id: string, userId: string) => {
    const m = await loadVisible(id, userId);
    if (m.status !== 'scheduled') throw badRequest('Only a scheduled message can be cancelled');
    await db.message.update({ where: { id }, data: { status: 'cancelled' } });
    await recordAudit({ action: 'message_cancelled', entity: 'message', entityId: id, changes: { subject: m.subject } });
    return getMessage(id, userId);
};

// ─── Sent box ────────────────────────────────────────────────────────────────

const loadVisible = async (id: string, userId: string) => {
    const p = await powers(userId);
    const m = await db.message.findFirst({ where: { id, kind: 'compose' } });
    if (!m) throw notFound('Message not found');
    if (p.viewSent !== 'all' && m.createdBy !== userId) throw forbidden();
    return m;
};

export const sentQuery = z.object({ page: z.coerce.number().int().min(1).default(1), search: z.string().trim().max(100).optional(), status: z.enum(['scheduled', 'sent', 'cancelled']).optional() });
export const listSent = async (q: z.infer<typeof sentQuery>, userId: string) => {
    const p = await powers(userId);
    const where: Prisma.MessageWhereInput = {
        kind: 'compose',
        ...(p.viewSent === 'all' ? {} : { createdBy: userId }),
        ...(q.status ? { status: q.status === 'sent' ? { in: ['sent', 'sending'] } : q.status } : {}),
        ...(q.search ? { OR: [{ subject: { contains: q.search, mode: 'insensitive' } }, { audienceLabel: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const take = 25;
    const [rows, total] = await Promise.all([db.message.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * take, take }), db.message.count({ where })]);
    const stats = rows.length ? await db.messageDelivery.groupBy({ by: ['messageId', 'status'], where: { messageId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }) : [];
    const senders = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdBy!).filter(Boolean) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    return {
        rows: rows.map((m) => ({
            id: m.id,
            subject: m.subject,
            audience: m.audienceLabel,
            channels: m.channels,
            status: m.status,
            sendAt: m.sendAt,
            sentAt: m.sentAt,
            recipients: m.recipients,
            by: m.createdBy ? (senders.get(m.createdBy) ?? null) : null,
            counts: Object.fromEntries(stats.filter((x) => x.messageId === m.id).map((x) => [x.status, x._count._all])),
        })),
        total,
        page: q.page,
        pages: Math.max(1, Math.ceil(total / take)),
    };
};

export const getMessage = async (id: string, userId: string) => {
    const m = await loadVisible(id, userId);
    const deliveries = await db.messageDelivery.findMany({ where: { messageId: id }, orderBy: [{ recipientName: 'asc' }, { channel: 'asc' }], take: 2000, select: { id: true, recipientName: true, recipientKind: true, channel: true, address: true, status: true, reason: true, sentAt: true, userId: true } });
    const reads = await db.notification.findMany({ where: { messageId: id, readAt: { not: null } }, select: { userId: true } });
    const read = new Set(reads.map((r) => r.userId));
    const files = m.attachmentIds.length ? await db.file.findMany({ where: { id: { in: m.attachmentIds } }, select: { id: true, originalName: true } }) : [];
    return {
        id: m.id,
        subject: m.subject,
        body: m.body,
        shortText: m.shortText,
        channels: m.channels,
        priority: m.priority,
        categoryId: m.categoryId,
        audience: m.audienceLabel,
        cc: m.cc,
        status: m.status,
        sendAt: m.sendAt,
        sentAt: m.sentAt,
        reportCard: m.documentKey === 'report_card',
        attachments: files.map((f) => ({ id: f.id, name: f.originalName })),
        deliveries: deliveries.map((d) => ({ ...d, read: d.channel === 'in_app' && !!d.userId && read.has(d.userId) })),
    };
};

// ─── Templates and saved groups ──────────────────────────────────────────────

export const templateSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(80),
    categoryId: z.uuid().nullable().optional(),
    subject: z.string().trim().min(1, 'is required').max(200),
    body: z.string().trim().min(1, 'is required').max(20_000),
    shortText: z.string().trim().max(480).nullable().optional(),
});
export const listTemplates = () => db.messageTemplate.findMany({ orderBy: { name: 'asc' } });
export const saveTemplate = async (id: string | null, input: z.infer<typeof templateSchema>) => {
    const clash = await db.messageTemplate.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw badRequest('A template with this name exists', [{ field: 'name', message: 'is taken' }]);
    const data = { name: input.name, categoryId: input.categoryId ?? null, subject: input.subject, body: input.body, shortText: input.shortText ?? null };
    const t = id ? await db.messageTemplate.update({ where: { id }, data }) : await db.messageTemplate.create({ data: { ...data, tenantId: getTenantId()! } });
    await recordAudit({ action: id ? 'message_template_changed' : 'message_template_added', entity: 'message_template', entityId: t.id, changes: { name: t.name } });
    return t;
};
export const deleteTemplate = async (id: string) => {
    const t = await db.messageTemplate.findFirst({ where: { id } });
    if (!t) throw notFound('Template not found');
    await db.messageTemplate.delete({ where: { id } });
    await recordAudit({ action: 'message_template_deleted', entity: 'message_template', entityId: id, changes: { name: t.name } });
    return { id, deleted: true };
};

export const groupSchema = z.strictObject({ name: z.string().trim().min(1, 'is required').max(80), audience: audienceSchema });
export const listGroups = async () => {
    const rows = await db.recipientGroup.findMany({ orderBy: { name: 'asc' } });
    return Promise.all(rows.map(async (g) => ({ id: g.id, name: g.name, audience: g.audience, label: await describeAudience(audienceSchema.parse(g.audience)) })));
};
export const saveGroup = async (id: string | null, input: z.infer<typeof groupSchema>, userId: string) => {
    const p = await powers(userId);
    await checkAllowed(input.audience, userId, p);
    const clash = await db.recipientGroup.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw badRequest('A group with this name exists', [{ field: 'name', message: 'is taken' }]);
    const data = { name: input.name, audience: { ...input.audience, groupIds: [] } as Prisma.InputJsonValue };
    const g = id ? await db.recipientGroup.update({ where: { id }, data }) : await db.recipientGroup.create({ data: { ...data, tenantId: getTenantId()!, createdBy: userId } });
    return g;
};
export const deleteGroup = async (id: string) => {
    await db.recipientGroup.deleteMany({ where: { id } });
    return { id, deleted: true };
};

/** People, sections, classes and roles for the To line (search). */
export const pickerOptions = async (userId: string, search?: string) => {
    const p = await powers(userId);
    const year = await currentYear();
    const mine = p.assigned ? await ownSections(userId) : null;
    const sections = year
        ? await db.section.findMany({ where: { academicYearId: year.id, isActive: true, ...(mine ? { id: { in: [...mine] } } : {}) }, select: { id: true, classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] })
        : [];
    const q = search?.trim();
    const [students, staff, roles, classes] = await Promise.all([
        q && year
            ? db.enrolment.findMany({
                  where: { academicYearId: year.id, student: { status: 'active', OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { admissionNo: { contains: q, mode: 'insensitive' } }] }, ...(mine ? { sectionId: { in: [...mine] } } : {}) },
                  select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { firstName: true, middleName: true, lastName: true, admissionNo: true } } },
                  take: 15,
              })
            : [],
        q && !p.assigned ? db.staff.findMany({ where: { status: 'working', OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { employeeCode: { contains: q, mode: 'insensitive' } }] }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true }, take: 15 }) : [],
        p.groups ? db.role.findMany({ where: { slug: { notIn: ['student', 'guardian'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
        !p.assigned && year ? db.schoolClass.findMany({ where: { id: { in: [...new Set(sections.map((s) => s.classId))] } }, select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }) : [],
    ]);
    return {
        powers: p,
        sections: sections.map((s) => ({ id: s.id, label: sectionLabel(s) })),
        classes,
        roles,
        students: students.map((e) => ({ id: e.studentId, label: `${fullName(e.student)} · ${sectionLabel(e.section)} · ${e.student.admissionNo}` })),
        staff: staff.map((s) => ({ id: s.id, label: `${fullName(s)} · ${s.employeeCode}` })),
        groups: await listGroups(),
    };
};

// Scheduled messages go when their time comes.
onQueuePass(async () => {
    const due = await runAsSystem(() => db.message.findMany({ where: { status: 'scheduled', sendAt: { lte: new Date() } }, select: { id: true, tenantId: true }, take: 50 }));
    for (const m of due) await runAsTenant(m.tenantId, () => dispatch(m.id));
});
