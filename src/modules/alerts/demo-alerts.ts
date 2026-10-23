import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';
import { listOptions } from '../masters/masters.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { parentsOf, Recipient, staffOf } from './recipients';
import { fmtDate } from './format';

/**
 * Demo messages and alerts: saved templates, a saved group, a few sent messages, every demo login's
 * notifications and some days of the alert log. Nothing is actually sent (rows are written as sent).
 * Marked is_demo.
 */

let seed = 7_331;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;
const ago = (days: number, hour = 9) => new Date(Date.now() - days * DAY - (Date.now() % DAY) + (hour - 5.5) * 3_600_000);

const TEMPLATES = [
    { name: 'School closed (weather)', cat: 'Emergency', subject: 'School closed tomorrow', body: 'Dear {{name}},\n\nDue to heavy rain the school will remain closed tomorrow. Classes resume the day after.\n\nPlease keep children safe at home.', shortText: '{{school}}: school closed tomorrow due to heavy rain.' },
    { name: 'PTM invitation', cat: 'PTM', subject: 'Parent-teacher meeting on Saturday', body: 'Dear {{name}},\n\nYou are invited to the parent-teacher meeting of {{class}} on Saturday, 9:30 am to 12:30 pm, to discuss the progress of {{student}}.\n\nPlease bring the report card.', shortText: '{{school}}: PTM for {{class}} on Saturday 9:30 am. Please attend.' },
    { name: 'Fee reminder', cat: 'Fees', subject: 'Fee reminder for {{student}}', body: 'Dear {{name}},\n\nThis is a gentle reminder that the fees of {{student}} are due. Please pay at the school office or online.\n\nPlease ignore this if already paid.', shortText: '{{school}}: fees of {{student}} are due. Please pay soon.' },
    { name: 'Holiday', cat: 'Holiday', subject: 'Holiday on {{school}} calendar', body: 'Dear {{name}},\n\nThe school will remain closed on the coming holiday. Classes resume on the next working day.', shortText: '{{school}}: school closed for the holiday.' },
];

export const createDemoAlerts = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year) return { messages: 0, notifications: 0, log: 0 };
    const cats = await listOptions('message_category');
    const cat = (n: string) => cats.find((c) => c.name === n)?.id ?? null;
    const author = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'principal' } } } }, select: { id: true } });
    const office = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } });

    for (const t of TEMPLATES) {
        if (await db.messageTemplate.findFirst({ where: { name: t.name } })) continue;
        await db.messageTemplate.create({ data: { tenantId, name: t.name, categoryId: cat(t.cat), subject: t.subject, body: t.body, shortText: t.shortText, isDemo: true, createdBy: office?.id ?? null } });
    }

    const sections = await db.section.findMany({ where: { academicYearId: year.id, isActive: true }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] });
    const vii = sections.find((s) => sectionLabel(s) === 'VII-B') ?? sections[Math.floor(sections.length / 2)];
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { studentId: true, sectionId: true, student: { select: { firstName: true, middleName: true, lastName: true } } } });
    const inVii = enrol.filter((e) => e.sectionId === vii?.id);

    // A saved group.
    const team = enrol.filter((_, i) => i % 37 === 0).slice(0, 15).map((e) => e.studentId);
    if (!(await db.recipientGroup.findFirst({ where: { name: 'Sports team parents' } })))
        await db.recipientGroup.create({ data: { tenantId, name: 'Sports team parents', audience: { studentIds: team, who: ['parent'] } as Prisma.InputJsonValue, createdBy: office?.id ?? null } });

    // Run a second time: only what is still missing (templates above, custom alerts below).
    const again = (await db.notification.count({ where: { isDemo: true } })) > 0;

    // Sent messages, written as already delivered.
    const staffIds = (await db.staff.findMany({ where: { status: 'working' }, select: { id: true } })).map((s) => s.id);
    const [viiParents, staff, allParents] = await Promise.all([parentsOf(inVii.map((e) => e.studentId)), staffOf(staffIds), parentsOf(enrol.slice(0, 250).map((e) => e.studentId))]);
    const MESSAGES: { days: number; by: string | null; subject: string; body: string; channels: string[]; cat: string; label: string; audience: object; people: Recipient[] }[] = [
        { days: 6, by: author?.id ?? null, subject: 'Parent-teacher meeting on Saturday', body: TEMPLATES[1].body, channels: ['in_app', 'email'], cat: 'PTM', label: `parents of ${vii ? sectionLabel(vii) : ''}`, audience: { sectionIds: vii ? [vii.id] : [], who: ['parent'] }, people: viiParents },
        { days: 3, by: author?.id ?? null, subject: 'Annual day rehearsals from Monday', body: 'Dear {{name}},\n\nRehearsals for the annual day start on Monday in the last two periods. Class teachers, please send the participants on time.', channels: ['in_app'], cat: 'Event', label: 'All staff', audience: { allStaff: true }, people: staff },
        { days: 1, by: office?.id ?? null, subject: 'Winter uniform from 1 November', body: 'Dear {{name}},\n\nStudents are to come in the winter uniform from 1 November. The uniform shop is open on Saturdays.', channels: ['in_app', 'email'], cat: 'General', label: 'All parents', audience: { allParents: true }, people: allParents },
    ];
    let messages = 0;
    let notifications = 0;
    for (const m of again ? [] : MESSAGES) {
        if (!m.people.length || (await db.message.findFirst({ where: { subject: m.subject, isDemo: true } }))) continue;
        const at = ago(m.days, 10);
        const msg = await db.message.create({ data: { tenantId, kind: 'compose', subject: m.subject, body: m.body, channels: m.channels, categoryId: cat(m.cat), audience: m.audience as Prisma.InputJsonValue, audienceLabel: m.label, status: 'sent', sendAt: at, sentAt: at, recipients: m.people.length, isDemo: true, createdBy: m.by, createdAt: at } });
        const rows: Prisma.MessageDeliveryCreateManyInput[] = [];
        const notes: Prisma.NotificationCreateManyInput[] = [];
        for (const p of m.people) {
            const body = m.body.replace(/\{\{name\}\}/g, p.name).replace(/\{\{[a-z]+\}\}/g, '');
            if (m.channels.includes('in_app') && p.userId) {
                const read = rand() < 0.6;
                notes.push({ tenantId, userId: p.userId, type: 'messages', title: m.subject, body: body.replace(/\s+/g, ' ').slice(0, 300), link: '/notifications', messageId: msg.id, readAt: read ? new Date(at.getTime() + 3_600_000) : null, isDemo: true, createdAt: at });
                rows.push({ tenantId, messageId: msg.id, userId: p.userId, recipientName: p.name, recipientKind: p.kind, channel: 'in_app', status: 'sent', subject: m.subject, body: body.slice(0, 500), sentAt: at, readAt: read ? new Date(at.getTime() + 3_600_000) : null, isDemo: true, createdAt: at });
            }
            if (m.channels.includes('email') && p.email) {
                const failed = rand() < 0.04;
                rows.push({ tenantId, messageId: msg.id, userId: p.userId, recipientName: p.name, recipientKind: p.kind, channel: 'email', address: p.email, status: failed ? 'failed' : 'sent', reason: failed ? '550 mailbox not found' : null, attempts: failed ? 4 : 1, subject: m.subject, body, sentAt: failed ? null : at, isDemo: true, createdAt: at });
            }
            if (!p.userId && !p.email) rows.push({ tenantId, messageId: msg.id, recipientName: p.name, recipientKind: p.kind, channel: m.channels[0], status: 'skipped', reason: 'no login, email or mobile to reach them on', subject: m.subject, body: '', isDemo: true, createdAt: at });
        }
        await db.messageDelivery.createMany({ data: rows });
        await db.notification.createMany({ data: notes });
        notifications += notes.length;
        messages++;
    }

    // Alerts of the last days: absent and fee reminders to some parents, results published.
    const exam = await db.exam.findFirst({ where: { academicYearId: year.id, status: 'published' }, orderBy: { publishedAt: 'desc' }, select: { name: true } });
    let log = 0;
    const sample = again ? [] : enrol.filter((_, i) => i % 9 === 0).slice(0, 120);
    const parentOf = new Map<string, Recipient>();
    for (const p of await parentsOf(sample.map((e) => e.studentId))) for (const s of p.studentIds) if (!parentOf.has(s)) parentOf.set(s, p);
    const sec = new Map(sections.map((s) => [s.id, sectionLabel(s)]));
    const rows: Prisma.MessageDeliveryCreateManyInput[] = [];
    const notes: Prisma.NotificationCreateManyInput[] = [];
    for (const e of sample) {
        const p = parentOf.get(e.studentId);
        if (!p) continue;
        const student = fullName(e.student);
        const days = Math.floor(rand() * 6) + 1;
        const at = ago(days, 9);
        const kind = rand();
        const a =
            kind < 0.45
                ? { key: 'attendance_absent', type: 'attendance', subject: `${student} is absent today`, body: `${student} (${sec.get(e.sectionId)}) was marked Absent on ${fmtDate(at)}.`, link: '/my-attendance', priority: 'normal' }
                : kind < 0.8
                  ? { key: 'fee_due_soon', type: 'fees', subject: `Quarter 3 fees of ${student} are due soon`, body: `A reminder that the Quarter 3 fees of ${student} are due in 3 days.`, link: '/my-fees', priority: 'normal' }
                  : { key: 'exam_results_published', type: 'exams', subject: `${exam?.name ?? 'Half-Yearly'} results are out`, body: `The ${exam?.name ?? 'Half-Yearly'} results of ${student} are now published.`, link: '/my-results', priority: 'normal' };
        const dedupe = `demo:${a.key}:${e.studentId}`;
        if (p.userId) {
            const read = rand() < 0.5;
            notes.push({ tenantId, userId: p.userId, type: a.type, title: a.subject, body: a.body, link: a.link, priority: a.priority, alertKey: a.key, readAt: read ? new Date(at.getTime() + 7_200_000) : null, isDemo: true, createdAt: at });
            rows.push({ tenantId, alertKey: a.key, userId: p.userId, recipientName: p.name, recipientKind: 'parent', channel: 'in_app', status: 'sent', subject: a.subject, body: a.body, sentAt: at, sectionIds: [e.sectionId], dedupeKey: `${dedupe}:in_app`, isDemo: true, createdAt: at });
        }
        if (p.email) {
            const r = rand();
            rows.push({ tenantId, alertKey: a.key, userId: p.userId, recipientName: p.name, recipientKind: 'parent', channel: 'email', address: p.email, status: r < 0.05 ? 'failed' : 'sent', reason: r < 0.05 ? 'connection timed out (tried 4 times)' : null, attempts: r < 0.05 ? 4 : 1, subject: a.subject, body: a.body, sentAt: r < 0.05 ? null : at, sectionIds: [e.sectionId], dedupeKey: `${dedupe}:email`, isDemo: true, createdAt: at });
        }
        if (!p.userId && !p.email) rows.push({ tenantId, alertKey: a.key, recipientName: p.name, recipientKind: 'parent', channel: 'email', status: 'skipped', reason: 'no login, email or mobile to reach them on', subject: a.subject, body: a.body, sectionIds: [e.sectionId], dedupeKey: `${dedupe}:none`, isDemo: true, createdAt: at });
    }
    if (rows.length) log = (await db.messageDelivery.createMany({ data: rows, skipDuplicates: true })).count;
    if (notes.length) notifications += (await db.notification.createMany({ data: notes })).count;

    // Staff with logins: a leave to approve and a marks reminder, so their bell isn't empty.
    const principal = author ? await db.user.findFirst({ where: { id: author.id }, select: { id: true, displayName: true } }) : null;
    const teacherUsers = await db.user.findMany({ where: { isDemo: true, roles: { some: { role: { slug: { in: ['teacher', 'class-teacher'] } } } } }, select: { id: true }, take: 60 });
    const staffNotes: Prisma.NotificationCreateManyInput[] = [];
    if (principal) staffNotes.push({ tenantId, userId: principal.id, type: 'leave', title: 'Leave request: Deepak Rautela, 2 day(s)', body: 'Deepak Rautela has asked for Casual Leave. Please approve or reject it.', link: '/leave/approvals', priority: 'normal', alertKey: 'leave_applied', isDemo: true, createdAt: ago(0, 8) });
    for (const t of teacherUsers) staffNotes.push({ tenantId, userId: t.id, type: 'notices', title: 'Notice: Annual day rehearsals from Monday', body: 'Rehearsals for the annual day start on Monday in the last two periods.', link: '/notices', priority: 'important', alertKey: 'notice_published', isDemo: true, createdAt: ago(2, 11) });
    if (staffNotes.length && !again) notifications += (await db.notification.createMany({ data: staffNotes })).count;

    // Two custom alerts, ready but switched off.
    const CUSTOM = [
        {
            name: 'Attendance below 75% (weekly)',
            reportKey: 'attendance_percentage',
            filters: { show: 'below' },
            sendTo: ['parent', 'class_teacher'],
            frequency: 'weekly',
            day: 1,
            subject: 'Attendance of {{student}} is {{percent}}%',
            body: 'Dear {{name}},\n\nThe attendance of {{student}} ({{group}}) this session is {{percent}}% ({{present}} of {{days}} days). Students need 75% to sit the exams.\n\nPlease make sure {{student}} comes to school regularly.',
            shortText: '{{school}}: attendance of {{student}} is {{percent}}%. 75% is needed.',
            summarySubject: '{{alert}}: {{count}} of your students',
            summaryBody: 'These students are below 75% attendance:\n\n{{list}}',
        },
        {
            name: 'Fee defaulters (monthly)',
            reportKey: 'fee_defaulters',
            filters: { show: 'overdue' },
            sendTo: ['parent'],
            frequency: 'monthly',
            day: 1,
            subject: 'Fees of {{student}} are overdue: {{overdue}}',
            body: 'Dear {{name}},\n\nFees of {{overdue}} for {{student}} ({{overdueInstalments}}) are overdue. Please pay at the school office or online.',
            shortText: '{{school}}: {{overdue}} overdue for {{student}}. Please pay soon.',
            summarySubject: '{{alert}}: {{count}}',
            summaryBody: '{{list}}',
        },
    ];
    if (author)
        for (const c of CUSTOM)
            if (!(await db.customAlert.findFirst({ where: { name: c.name } })))
                await db.customAlert.create({ data: { tenantId, ...c, time: '08:00', channels: ['in_app', 'email'], type: c.reportKey.startsWith('fee') ? 'fees' : 'attendance', repeatDays: 7, enabled: false, isDemo: true, createdBy: author.id } });

    return { messages, notifications, log };
};

export const clearDemoAlerts = async () => {
    await db.notification.deleteMany({ where: { isDemo: true } });
    await db.messageDelivery.deleteMany({ where: { isDemo: true } });
    await db.message.deleteMany({ where: { isDemo: true } });
    await db.messageTemplate.deleteMany({ where: { isDemo: true } });
    await db.customAlert.deleteMany({ where: { isDemo: true } });
    await db.recipientGroup.deleteMany({ where: { name: 'Sports team parents' } });
    // Notifications and log rows of demo people that real alerts made while the demo ran.
    const demoUsers = (await db.user.findMany({ where: { isDemo: true }, select: { id: true } })).map((u) => u.id);
    if (demoUsers.length) {
        await db.notification.deleteMany({ where: { userId: { in: demoUsers } } });
        await db.messageDelivery.deleteMany({ where: { userId: { in: demoUsers } } });
        await db.notificationPreference.deleteMany({ where: { userId: { in: demoUsers } } });
    }
};
