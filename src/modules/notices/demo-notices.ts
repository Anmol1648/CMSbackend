import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { listOptions } from '../masters/masters.service';
import { membersOf, population } from './audience';

/**
 * Demo notices and events: circulars, exam and fee notices (some read and acknowledged), and the
 * year's events (PTM, sports day, annual function, exams, a trip). Marked is_demo.
 */

let seed = 4_219;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));
const NONE = { forEveryone: false, forAllStaff: false, roleIds: [] as string[], forStudents: false, forParents: false, classIds: [] as string[], sectionIds: [] as string[] };

export const createDemoNotices = async () => {
    const tenantId = getTenantId()!;
    const today = todayIST();
    const [cats, types, year] = await Promise.all([listOptions('notice_category'), listOptions('event_type'), currentYear()]);
    const cat = (n: string) => cats.find((c) => c.name === n)?.id ?? null;
    const type = (n: string) => types.find((t) => t.name === n)?.id ?? null;
    const author = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: { in: ['principal', 'office-staff'] } } } } }, select: { id: true } });
    const sections = year ? await db.section.findMany({ where: { academicYearId: year.id, isActive: true }, select: { id: true, classId: true }, take: 40 }) : [];
    const someSection = sections[Math.floor(sections.length / 2)];

    const NOTICES = [
        { days: -40, cat: 'Circular', title: 'Revised school timings from 1 November', body: 'Dear parents,\n\nFrom **1 November** the school will run in the winter timings:\n- Classes VI to XII: 8:30 am to 2:30 pm\n- Primary: 8:45 am to 1:30 pm\n\nThe bus timings change by 30 minutes. The transport in-charge will share the new pick-up times.', a: { ...NONE, forEveryone: true }, ack: true, important: true },
        { days: -30, cat: 'Exam notice', title: 'Half-yearly examination date sheet', body: 'The half-yearly examinations begin on the date in the attached schedule. Students must carry their admit cards.\n\n- Syllabus: as shared by the subject teachers\n- Reporting time: 8:15 am\n\nNo student will be allowed after 8:30 am.', a: { ...NONE, forStudents: true, forParents: true }, ack: true, important: true },
        { days: -25, cat: 'Fee notice', title: 'Second instalment of fees due on 15 October', body: 'The second instalment of the session’s fees is due on **15 October**. A late fine applies after the due date.\n\nFees can be paid at the school counter or online from My Fees.', a: { ...NONE, forParents: true }, ack: false, important: false },
        { days: -20, cat: 'Staff notice', title: 'Staff meeting on Saturday after school', body: 'All teaching staff are requested to attend a meeting in the staff room at 2:45 pm on Saturday.\n\nAgenda:\n- Half-yearly exam duties\n- Annual day preparation\n- Remedial classes', a: { ...NONE, forAllStaff: true }, ack: true, important: false },
        { days: -14, cat: 'General notice', title: 'Winter uniform from 15 November', body: 'Students will come in the winter uniform (blazer, sweater and full pants / salwar) from 15 November.', a: { ...NONE, forStudents: true, forParents: true }, ack: false, important: false },
        { days: -10, cat: 'Holiday notice', title: 'School closed for Diwali', body: 'The school remains closed for Diwali. Classes resume after the break as per the calendar.\n\nWishing everyone a happy and safe Diwali.', a: { ...NONE, forEveryone: true }, ack: false, important: false },
        { days: -7, cat: 'Circular', title: 'Annual Sports Meet: house practice schedule', body: 'House practice for the Annual Sports Meet will be held in the last period every day. House captains will share the event lists.', a: { ...NONE, forStudents: true }, ack: false, important: false },
        { days: -5, cat: 'Urgent', title: 'Heavy rain alert: school closed tomorrow', body: 'Following the district administration’s order, the school will remain closed tomorrow because of the heavy rain alert. Online assignments will be shared by the class teachers.', a: { ...NONE, forEveryone: true }, ack: true, important: true, expires: -3 },
        { days: -3, cat: 'Circular', title: 'Parent-teacher meeting on Saturday', body: 'The parent-teacher meeting for all classes will be held on Saturday from **9:00 am to 12:30 pm**. Parents can meet the class teacher and the subject teachers.', a: { ...NONE, forParents: true }, ack: true, important: false },
        { days: -2, cat: 'Event', title: 'Science exhibition: entries open', body: 'Students of classes VI to X can submit their science models for the inter-house exhibition. Give the names to your science teacher by Friday.', a: { ...NONE, forStudents: true }, ack: false, important: false },
        ...(someSection ? [{ days: -1, cat: 'General notice', title: 'Class picnic: consent forms', body: 'Parents are requested to send the signed consent form for the class picnic with the fee of ₹350 by Thursday.', a: { ...NONE, forParents: true, sectionIds: [someSection.id] }, ack: true, important: false }] : []),
        { days: 0, cat: 'Staff notice', title: 'Submit the remedial class plans', body: 'Class teachers are requested to submit the remedial class plans for students below 40% in the unit tests, by Monday.', a: { ...NONE, forAllStaff: true }, ack: false, important: false },
    ];
    const DRAFTS = [
        { cat: 'Circular', title: 'Annual function: rehearsal schedule (draft)', body: 'Rehearsals for the annual function will be held…', a: { ...NONE, forStudents: true, forParents: true } },
        { cat: 'Fee notice', title: 'Fee concession applications for next session (draft)', body: 'Applications for fee concession for the next session can be submitted to the office…', a: { ...NONE, forParents: true } },
    ];
    const created = [];
    for (const n of NOTICES) {
        const at = new Date(dayDate(addDays(today, n.days)).getTime() + (3.5 + rand() * 4) * 3600_000);
        created.push(
            await db.notice.create({
                data: {
                    tenantId,
                    title: n.title,
                    body: n.body,
                    categoryId: cat(n.cat),
                    important: n.important,
                    status: 'published',
                    publishAt: at,
                    publishedAt: at,
                    publishedBy: author?.id ?? null,
                    expiresOn: 'expires' in n && typeof n.expires === 'number' ? dayDate(addDays(today, n.expires)) : null,
                    needsAck: n.ack,
                    ...n.a,
                    isDemo: true,
                },
            })
        );
    }
    for (const d of DRAFTS) await db.notice.create({ data: { tenantId, title: d.title, body: d.body, categoryId: cat(d.cat), status: 'draft', ...d.a, isDemo: true } });

    // Most of the staff and many families have read them; about half of those asked acknowledged.
    const everyone = await population();
    const reads = created.flatMap((n) => {
        const share = 0.35 + rand() * 0.5;
        return membersOf(n, everyone)
            .filter(() => rand() < share)
            .map((m) => ({ tenantId, noticeId: n.id, userId: m.userId, readAt: new Date(n.publishAt!.getTime() + rand() * 2 * DAY), acknowledgedAt: n.needsAck && rand() < 0.6 ? new Date(n.publishAt!.getTime() + rand() * 3 * DAY) : null }));
    });
    if (reads.length) await db.noticeRead.createMany({ data: reads, skipDuplicates: true });

    const EVENTS = [
        { d: -45, len: 1, type: 'Celebration', title: 'Teachers’ Day celebration', venue: 'School hall', t: ['10:00', '12:30'], a: { ...NONE, forEveryone: true } },
        { d: -20, len: 6, type: 'Exam', title: 'Half-yearly examinations', venue: 'Classrooms', t: ['08:30', '11:30'], a: { ...NONE, forStudents: true, forParents: true } },
        { d: -8, len: 3, type: 'Holiday', title: 'Diwali break', venue: null, t: null, a: { ...NONE, forEveryone: true }, holiday: 'both' },
        { d: 3, len: 1, type: 'PTM', title: 'Parent-teacher meeting', venue: 'Classrooms', t: ['09:00', '12:30'], a: { ...NONE, forParents: true, forAllStaff: true } },
        { d: 9, len: 2, type: 'Sports', title: 'Annual Sports Meet', venue: 'School ground', t: ['08:30', '14:00'], a: { ...NONE, forEveryone: true } },
        { d: 16, len: 1, type: 'Competition', title: 'Inter-house science exhibition', venue: 'Science block', t: ['10:00', '13:00'], a: { ...NONE, forStudents: true, forParents: true } },
        { d: 22, len: 1, type: 'Meeting', title: 'School management committee meeting', venue: 'Principal’s office', t: ['15:00', '16:30'], a: { ...NONE, forAllStaff: true } },
        { d: 30, len: 1, type: 'Trip / Excursion', title: 'Educational trip to Auli', venue: 'Auli', t: ['07:30', '17:00'], a: { ...NONE, forStudents: true, forParents: true, ...(someSection ? { classIds: [someSection.classId] } : {}) } },
        { d: 40, len: 1, type: 'Cultural programme', title: 'Annual Day', venue: 'School auditorium', t: ['16:00', '19:30'], a: { ...NONE, forEveryone: true } },
        { d: 55, len: 1, type: 'Holiday', title: 'Christmas', venue: null, t: null, a: { ...NONE, forEveryone: true }, holiday: 'both' },
        { d: 70, len: 5, type: 'Exam', title: 'Pre-board examinations (X and XII)', venue: 'Exam hall', t: ['09:00', '12:00'], a: { ...NONE, forStudents: true, forParents: true } },
        { d: 85, len: 1, type: 'Celebration', title: 'Republic Day', venue: 'School ground', t: ['08:00', '10:00'], a: { ...NONE, forEveryone: true } },
    ];
    let events = 0;
    for (const e of EVENTS) {
        const from = addDays(today, e.d);
        const row = await db.schoolEvent.create({
            data: {
                tenantId,
                title: e.title,
                typeId: type(e.type),
                startDate: dayDate(from),
                endDate: dayDate(addDays(from, e.len - 1)),
                startTime: e.t?.[0] ?? null,
                endTime: e.t?.[1] ?? null,
                venue: e.venue,
                holidayFor: 'holiday' in e && e.holiday ? e.holiday : 'none',
                ...e.a,
                isDemo: true,
            },
        });
        if (row.holidayFor !== 'none') {
            const data = [];
            for (let t = row.startDate.getTime(); t <= row.endDate.getTime(); t += DAY) data.push({ tenantId, date: new Date(t), name: row.title, eventId: row.id, isDemo: true });
            await db.holiday.createMany({ data, skipDuplicates: true });
        }
        events++;
    }
    return { notices: created.length + DRAFTS.length, reads: reads.length, events };
};

export const clearDemoNotices = async () => {
    const ids = (await db.schoolEvent.findMany({ where: { isDemo: true }, select: { id: true } })).map((e) => e.id);
    await db.holiday.deleteMany({ where: { eventId: { in: ids } } });
    await db.schoolEvent.deleteMany({ where: { isDemo: true } });
    // Reads of demo logins on real notices go with the logins; demo notices take theirs along.
    return (await db.notice.deleteMany({ where: { isDemo: true } })).count;
};
