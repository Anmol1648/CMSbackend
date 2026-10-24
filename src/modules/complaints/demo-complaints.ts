import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { takeNumbers } from '../../core/numbering';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { pickHandler } from './complaints.service';

/**
 * Demo complaints: about 40 over two months from parents (most), staff, students, the office
 * (walk-ins) and a few anonymous ones, in every state: new, in progress, overdue and escalated,
 * resolved, closed and rated. Mahesh Nautiyal has an open bus complaint and a resolved academic one.
 * Marked is_demo.
 */

let seed = 8_811;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const HOUR = 3_600_000;

const TEXT: Record<string, [string, string][]> = {
    'Academics / teaching': [
        ['Maths syllabus is behind', 'The maths teacher has finished only 3 chapters while the half-yearly exam is near. Please check.'],
        ['Need extra help in science', 'My child is struggling with science. Can the teacher suggest extra practice or a remedial class?'],
    ],
    'Homework / exams': [
        ['Too much homework on Mondays', 'Every Monday there is homework in 5 subjects. It is hard for a Class VI child to finish.'],
        ['Unit test marks not shown', 'The unit test marks are not on the app yet though other sections can see them.'],
    ],
    'Transport / bus': [
        ['Bus comes late every day', 'The Route 1 bus reaches Gandhi Nagar 15–20 minutes late in the morning. Children wait in the cold.'],
        ['Bus driver drives fast', 'The van on the Singhdhar route goes very fast on the turns. Please speak to the driver.'],
    ],
    'Fees / payments': [
        ['Paid online but shows due', 'I paid the second instalment online on 12 Oct but the app still shows it as due.'],
        ['Need fee receipt copy', 'Please send a copy of the receipt for the first instalment; the original is lost.'],
    ],
    'Staff behaviour': [['Rude behaviour at the office', 'The person at the counter was rude when I asked about the TC.']],
    'Bullying / safety': [['A boy is being bullied in the bus', 'Some senior students tease and push a small boy in the afternoon bus every day.']],
    'Building / furniture / facilities': [
        ['Broken benches in VII-B', 'Two benches in the classroom are broken and children sit three to a bench.'],
        ['Fans not working', 'Two fans in the science lab are not working.'],
    ],
    'Drinking water / toilets / hygiene': [['Water cooler not cleaned', 'The water cooler near the primary block looks dirty; the filter may need changing.']],
    'App / website / login': [['Cannot log in to the app', 'My password is not working after the update. Please reset it.']],
    Other: [['Lost and found', 'My child lost a blue water bottle in the playground last Friday.']],
};
const STAFF_REPLIES = ['Thank you for telling us. We are looking into it and will update you soon.', 'We have spoken to the concerned person; this will be fixed this week.', 'Could you share the date and time when this happened?', 'The class teacher will call you today.'];
const PARENT_REPLIES = ['Thank you, waiting for the update.', 'It happened on Tuesday morning, around 7:40.', 'It is still the same today.', 'Okay, thank you.'];
const RESOLUTIONS = ['The issue was fixed and checked.', 'Spoke to the teacher; an extra class is arranged every Saturday.', 'The driver was warned and the speed is now monitored on the live map.', 'The payment was matched; the receipt is on My Fees.', 'New benches were given to the class.'];

export const createDemoComplaints = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.complaint.count({ where: { isDemo: true } }))) return { complaints: 0 };
    await seedMasters();
    const cats = await db.masterValue.findMany({ where: { master: 'complaint_category', isActive: true }, select: { id: true, name: true, extra: true } });
    const catByName = new Map(cats.map((c) => [c.name, c]));
    const guardians = await db.guardian.findMany({ where: { userId: { not: null }, user: { isDemo: true } }, select: { userId: true, name: true, familyId: true }, take: 200 });
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', familyId: { in: guardians.map((g) => g.familyId) } } }, select: { studentId: true, student: { select: { familyId: true } } } });
    const staffUsers = await db.staff.findMany({ where: { isDemo: true, userId: { not: null }, status: 'working' }, select: { userId: true }, take: 30 });
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true, familyId: true } });
    const mahesh = shubham?.familyId ? await db.guardian.findFirst({ where: { familyId: shubham.familyId, userId: { not: null } }, select: { userId: true, name: true } }) : null;
    const routes = await db.transportRoute.findMany({ select: { id: true, name: true } });
    const userNames = new Map((await db.user.findMany({ select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const now = Date.now();
    let made = 0;

    const one = async (o: { cat: string; subject?: string; details?: string; by: string | null; as: 'parent' | 'staff' | 'student' | 'office'; studentId: string | null; ago: number; state: string; anonymous?: boolean; contact?: string; routeId?: string | null }) => {
        const cat = catByName.get(o.cat) ?? cats[0];
        const x = (cat.extra ?? {}) as { handler?: string; response_hours?: number; resolve_hours?: number; urgent?: boolean };
        const [subject, details] = o.subject ? [o.subject, o.details!] : pick(TEXT[cat.name] ?? TEXT.Other);
        const created = new Date(now - o.ago * HOUR);
        const handler = await pickHandler(x.handler || 'office-staff', o.studentId);
        const respondBy = new Date(created.getTime() + (Number(x.response_hours) || 24) * HOUR);
        const resolveBy = new Date(created.getTime() + (Number(x.resolve_hours) || 72) * HOUR);
        const replied = o.state !== 'new' && o.state !== 'assigned';
        const firstResponseAt = replied ? new Date(created.getTime() + between(2, 20) * HOUR) : null;
        const resolvedAt = ['resolved', 'closed'].includes(o.state) ? new Date(Math.min(now - HOUR, created.getTime() + between(20, 70) * HOUR)) : null;
        const open = !resolvedAt;
        const overdueNow = open && resolveBy.getTime() < now;
        const yr = new Date(created.getTime() + 5.5 * HOUR).toISOString().slice(0, 4);
        const c = await db.complaint.create({
            data: {
                tenantId,
                ticketNo: `CMP-${yr}-${String(await takeNumbers(`complaint:${yr}`, 1)).padStart(4, '0')}`,
                categoryId: cat.id,
                subject,
                details,
                priority: x.urgent ? 'urgent' : rand() < 0.25 ? 'high' : 'normal',
                status: o.state,
                anonymous: !!o.anonymous,
                raisedBy: o.by,
                raisedAs: o.as,
                contactName: o.as === 'office' ? (o.contact ?? 'Walk-in parent') : null,
                contactMobile: o.as === 'office' ? `9${between(100000000, 999999999)}` : null,
                studentId: o.studentId,
                routeId: o.routeId ?? null,
                assignedTo: handler,
                assignedAt: handler ? created : null,
                respondBy,
                resolveBy,
                firstResponseAt,
                resolvedAt,
                closedAt: o.state === 'closed' ? new Date(resolvedAt!.getTime() + between(1, 48) * HOUR) : null,
                resolution: resolvedAt ? pick(RESOLUTIONS) : null,
                escalation: overdueNow ? between(1, 2) : 0,
                escalatedAt: overdueNow ? new Date(now - between(2, 20) * HOUR) : null,
                reopened: o.state === 'reopened' ? 1 : 0,
                rating: o.state === 'closed' && rand() < 0.8 ? between(3, 5) : null,
                createdAt: created,
                isDemo: true,
            },
        });
        const raiser = o.anonymous ? 'Anonymous' : o.as === 'office' ? 'Office' : (userNames.get(o.by ?? '') ?? '');
        const hName = userNames.get(handler ?? '') ?? 'Office';
        const msgs: { kind: string; text: string; at: Date; fromRaiser?: boolean; author: string; userId: string | null }[] = [{ kind: 'event', text: `Raised${handler ? `; assigned to ${hName}` : ''}`, at: created, author: raiser, userId: o.by }];
        if (firstResponseAt) msgs.push({ kind: 'reply', text: pick(STAFF_REPLIES), at: firstResponseAt, author: hName, userId: handler });
        if (firstResponseAt && rand() < 0.6) msgs.push({ kind: 'reply', text: pick(PARENT_REPLIES), at: new Date(firstResponseAt.getTime() + between(1, 10) * HOUR), fromRaiser: true, author: raiser, userId: o.by });
        if (firstResponseAt && rand() < 0.4) msgs.push({ kind: 'note', text: pick(['Checked with the class teacher.', 'Need to confirm with the transport in-charge.', 'Parent called the office too.']), at: new Date(firstResponseAt.getTime() + 2 * HOUR), author: hName, userId: handler });
        if (overdueNow) msgs.push({ kind: 'event', text: 'Escalated (level 1): not resolved in time', at: new Date(resolveBy.getTime() + HOUR), author: 'System', userId: null });
        if (resolvedAt) msgs.push({ kind: 'event', text: `Resolved: ${c.resolution}`, at: resolvedAt, author: hName, userId: handler });
        if (o.state === 'reopened') msgs.push({ kind: 'reply', text: 'Reopened: It is still happening.', at: new Date(now - between(2, 12) * HOUR), fromRaiser: true, author: raiser, userId: o.by });
        if (o.state === 'closed') msgs.push({ kind: 'event', text: `Accepted and closed by the complainant${c.rating ? ` · rated ${c.rating}/5` : ''}`, at: c.closedAt!, author: raiser, userId: o.by });
        await db.complaintMessage.createMany({ data: msgs.filter((m) => m.at.getTime() <= now).map((m) => ({ tenantId, complaintId: c.id, userId: m.userId, authorName: m.author, kind: m.kind, fromRaiser: !!m.fromRaiser, text: m.text, createdAt: m.at, isDemo: true })) });
        made++;
    };

    // Mahesh Nautiyal (Shubham's father): an open bus complaint and a resolved academic one.
    if (mahesh?.userId && shubham) {
        const r1 = routes.find((r) => r.name.startsWith('Route 1')) ?? null;
        await one({ cat: 'Transport / bus', subject: 'Bus comes late at Gandhi Nagar', details: 'The Route 1 bus reaches Gandhi Nagar 15–20 minutes late most mornings. Shubham reaches school after the assembly.', by: mahesh.userId, as: 'parent', studentId: shubham.id, ago: 30, state: 'in_progress', routeId: r1?.id ?? null });
        await one({ cat: 'Academics / teaching', subject: 'Maths practice for Shubham', details: 'Shubham got low marks in the maths unit test. Can the teacher give extra practice?', by: mahesh.userId, as: 'parent', studentId: shubham.id, ago: 110, state: 'resolved' });
    }
    const states = ['closed', 'closed', 'closed', 'resolved', 'in_progress', 'in_progress', 'assigned', 'assigned', 'reopened', 'new'];
    for (let i = 0; i < 30; i++) {
        const g = pick(guardians);
        const child = enrol.find((e) => e.student.familyId === g.familyId);
        await one({ cat: pick(cats).name, by: g.userId, as: 'parent', studentId: child?.studentId ?? null, ago: between(2, 60 * 24), state: pick(states) });
    }
    for (let i = 0; i < 4; i++) await one({ cat: pick(['Building / furniture / facilities', 'App / website / login', 'Drinking water / toilets / hygiene']), by: pick(staffUsers).userId, as: 'staff', studentId: null, ago: between(5, 40 * 24), state: pick(states) });
    for (const c of ['Bullying / safety', 'Drinking water / toilets / hygiene', 'Staff behaviour']) {
        const g = pick(guardians);
        await one({ cat: c, by: g.userId, as: 'parent', studentId: null, ago: between(6, 20 * 24), state: pick(['in_progress', 'resolved', 'assigned']), anonymous: true });
    }
    const admin = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } });
    for (const name of ['Ramesh Negi', 'Kamla Devi', 'Sunil Bisht']) await one({ cat: pick(['Fees / payments', 'Transport / bus', 'Other']), by: admin?.id ?? null, as: 'office', studentId: pick(enrol)?.studentId ?? null, ago: between(10, 30 * 24), state: pick(states), contact: name });
    return { complaints: made };
};

export const clearDemoComplaints = async () => {
    await db.complaint.deleteMany({ where: { isDemo: true } });
};
