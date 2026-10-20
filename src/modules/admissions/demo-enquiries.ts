import { randomUUID } from 'crypto';
import type { TestResult } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { formatNumber, takeNumbers } from '../../core/numbering';
import { ADMISSIONS } from './admissions.settings';
import { listStages } from './enquiries.service';

/**
 * Demo admission enquiries for the current year: spread over the months before and after the
 * session starts, at every stage, with follow-ups. Some are converted: they point at demo students
 * of the same class (as if those students came through an enquiry).
 */

type Rand = { pick: <T>(l: readonly T[]) => T; between: (lo: number, hi: number) => number; chance: (p: number) => boolean };

export interface DemoAdmitted {
    id: string;
    classId: string;
    firstName: string;
    lastName: string | null;
    dateOfBirth: Date | null;
    genderId: string | null;
}

const NOTES = [
    'Asked about fees and transport.',
    'Father will visit with documents.',
    'Wants to see the school first.',
    'Asked about the Kendriya Vidyalaya admission priority.',
    'Transferred to Joshimath; needs a seat mid-session.',
    'Called back, no answer.',
    'Mother asked about the computer lab and sports.',
    'Will decide after the results of the current school.',
    'Sibling already studies here.',
    'Discussed bus route from Gopeshwar.',
];
const AREAS = ['Marwari', 'Singhdhar', 'Ravigram', 'Gandhinagar', 'Upper Bazaar', 'Manoharbagh', 'Gopeshwar', 'Karnaprayag', 'Chamoli', 'Gauchar'];
const SCHOOLS = ['Saraswati Shishu Mandir', 'Govt. Primary School Joshimath', 'St. Joseph Convent', 'Govt. Inter College', 'Holy Child School', 'Little Angels Public School'];
const KIDS = ['Aarav', 'Diya', 'Ishaan', 'Kavya', 'Vihaan', 'Anika', 'Reyansh', 'Myra', 'Advik', 'Saanvi', 'Ayaan', 'Pari', 'Kabir', 'Navya', 'Arnav', 'Riya', 'Shaurya', 'Aadhya', 'Atharv', 'Siya'];
const PARENTS = ['Ramesh', 'Suresh', 'Mahesh', 'Dinesh', 'Rajendra', 'Vinod', 'Harish', 'Kailash', 'Mohan', 'Govind', 'Prakash', 'Manoj', 'Sunil', 'Rakesh', 'Deepak', 'Sunita', 'Anita', 'Geeta', 'Meena', 'Rekha'];
const SURNAMES = ['Negi', 'Rawat', 'Bisht', 'Panwar', 'Bhandari', 'Joshi', 'Semwal', 'Thapliyal', 'Nautiyal', 'Chauhan', 'Rana', 'Butola', 'Dimri', 'Sati', 'Bhatt', 'Raturi', 'Pant', 'Sharma', 'Verma', 'Singh'];

const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const plus = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** Never after today (things that already happened). */
const upTo = (d: Date, last: Date) => (d > last ? last : d);

export const createDemoEnquiries = async (year: { id: string; startDate: Date }, admitted: DemoAdmitted[], rand: Rand, count = 150) => {
    const tenantId = getTenantId()!;
    const stages = await listStages();
    const open = stages.filter((s) => s.isActive && !s.won && !s.lost);
    const won = stages.find((s) => s.won);
    const lost = stages.find((s) => s.lost);
    if (!open.length || !won || !lost) return { enquiries: 0, followUps: 0, converted: 0 };
    const masters = await db.masterValue.findMany({ where: { master: { in: ['enquiry_source', 'enquiry_lost_reason', 'follow_up_outcome', 'gender', 'relation'] }, isActive: true }, select: { id: true, name: true, master: true, extra: true } });
    const of = (master: string) => masters.filter((m) => m.master === master);
    const named = (master: string, name: string) => masters.find((m) => m.master === master && m.name === name)?.id ?? null;
    const classes = await db.schoolClass.findMany({ where: { isActive: true }, select: { id: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } });
    const counsellors = await db.staff.findMany({ where: { isDemo: true, status: 'working', userId: { not: null } }, select: { id: true }, take: 4, orderBy: { employeeCode: 'asc' } });
    const s = await getSettings({ enquiry: ADMISSIONS.enquiryPattern, registration: ADMISSIONS.registrationPattern });

    // Entry classes (the first ones, then VI and XI) get most enquiries.
    const weightOf = (i: number) => (i <= 2 ? 6 : i === 7 || i === 12 ? 4 : 1);
    const weighted = classes.flatMap((c, i) => Array.from({ length: weightOf(i) }, () => c.id));
    const today = day(new Date());
    // From four months before the session starts until today.
    const from = plus(day(year.startDate), -120);
    const span = Math.max(1, Math.round((today.getTime() - from.getTime()) / 86_400_000));

    // Converted enquiries: up to a quarter, each pointing at a demo student of its class.
    const pool = [...admitted];
    const convertCount = Math.min(Math.round(count / 4), pool.length);

    interface Plan {
        date: Date;
        row: Record<string, unknown>;
        registered: boolean;
        followUps: { date: Date; outcomeId: string | null; note: string; nextDate: Date | null }[];
    }
    const plans: Plan[] = [];
    for (let i = 0; i < count; i++) {
        const date = plus(from, rand.between(0, span));
        const converted = i < convertCount;
        const student = converted ? pool.splice(rand.between(0, pool.length - 1), 1)[0] : null;
        const classId = student?.classId ?? rand.pick(weighted);
        const surname = rand.pick(SURNAMES);
        const age = Math.max(0, (date.getTime() - from.getTime()) / 86_400_000);
        // Older enquiries are further along: more are closed.
        const r = rand.between(0, 99);
        const stage = converted ? won : age > 150 && r < 35 ? lost : r < 12 ? lost : open[Math.min(open.length - 1, Math.floor((r / 100) * open.length * (age > 60 ? 1.2 : 0.8)))];
        const isOpen = !stage.won && !stage.lost;
        const sources = of('enquiry_source');
        const source = rand.chance(0.15) ? sources.find((x) => (x.extra as { online?: boolean }).online) ?? rand.pick(sources) : rand.pick(sources);
        const stageIndex = open.findIndex((o) => o.id === stage.id);
        const registered = stage.won || (stage.lost ? rand.chance(0.3) : stageIndex >= Math.floor(open.length / 2));
        const tested = registered && rand.chance(0.6);
        const followUps: Plan['followUps'] = [];
        const n = stage.id === open[0].id ? rand.between(0, 1) : rand.between(1, 4);
        let d = date;
        for (let k = 0; k < n; k++) {
            d = plus(d, rand.between(1, 9));
            if (d > today) break;
            followUps.push({ date: d, outcomeId: rand.pick(of('follow_up_outcome')).id, note: rand.pick(NOTES), nextDate: null });
        }
        for (let k = 0; k < followUps.length - 1; k++) followUps[k].nextDate = followUps[k + 1].date;
        // Due dates around today: some overdue, some coming up, never before the enquiry.
        const lastContact = followUps.at(-1)?.date ?? date;
        const next = isOpen ? new Date(Math.max(plus(lastContact, 1).getTime(), plus(today, rand.between(-6, 8)).getTime())) : null;
        if (followUps.length && next) followUps[followUps.length - 1].nextDate = next;
        plans.push({
            date,
            registered,
            followUps,
            row: {
                id: randomUUID(),
                tenantId,
                enquiryDate: date,
                academicYearId: year.id,
                classId,
                studentFirstName: student?.firstName ?? rand.pick(KIDS),
                studentLastName: student?.lastName ?? surname,
                dateOfBirth: student?.dateOfBirth ?? null,
                genderId: student?.genderId ?? (rand.chance(0.5) ? named('gender', 'Male') : named('gender', 'Female')),
                parentName: `${rand.pick(PARENTS)} ${student?.lastName ?? surname}`,
                relationId: rand.chance(0.7) ? named('relation', 'Father') : named('relation', 'Mother'),
                mobile: `9${rand.between(100000000, 999999999)}`,
                email: rand.chance(0.4) ? `${surname.toLowerCase()}${rand.between(10, 99)}@example.com` : null,
                area: rand.pick(AREAS),
                currentSchool: rand.chance(0.7) ? rand.pick(SCHOOLS) : null,
                sourceId: source?.id ?? null,
                stageId: stage.id,
                assignedToId: counsellors.length && rand.chance(0.85) ? rand.pick(counsellors).id : null,
                nextFollowUp: next,
                lostReasonId: stage.lost ? rand.pick(of('enquiry_lost_reason')).id : null,
                registrationDate: registered ? upTo(plus(date, rand.between(2, 12)), today) : null,
                testDate: tested ? upTo(plus(date, rand.between(10, 20)), today) : null,
                testScore: tested ? `${rand.between(22, 48)}/50` : null,
                testResult: (tested ? (stage.lost && rand.chance(0.5) ? 'failed' : 'passed') : registered ? 'pending' : 'not_needed') as TestResult,
                remarks: rand.chance(0.3) ? rand.pick(NOTES) : null,
                online: (source?.extra as { online?: boolean } | undefined)?.online ?? false,
                studentId: student?.id ?? null,
                convertedAt: student ? upTo(plus(date, rand.between(15, 40)), today) : null,
                isDemo: true,
            },
        });
    }

    // Numbers in date order, counting per calendar year when the pattern has the year.
    plans.sort((a, b) => a.date.getTime() - b.date.getTime());
    const numberAll = async (kind: 'enquiry' | 'registration', pattern: string, items: { date: Date; set: (no: string) => void }[]) => {
        const yearly = /\{YY(YY)?\}/.test(pattern);
        const groups = new Map<string, typeof items>();
        for (const it of items) {
            const key = yearly ? `${kind}:${it.date.getUTCFullYear()}` : kind;
            groups.set(key, [...(groups.get(key) ?? []), it]);
        }
        for (const [key, list] of groups) {
            const first = await takeNumbers(key, 1, list.length);
            list.forEach((it, n) => it.set(formatNumber(pattern, { seq: first + n, date: it.date })));
        }
    };
    await numberAll('enquiry', s.enquiry, plans.map((p) => ({ date: p.date, set: (no) => (p.row.enquiryNo = no) })));
    const regs = plans.filter((p) => p.registered).sort((a, b) => (a.row.registrationDate as Date).getTime() - (b.row.registrationDate as Date).getTime());
    await numberAll('registration', s.registration, regs.map((p) => ({ date: p.row.registrationDate as Date, set: (no) => (p.row.registrationNo = no) })));

    await db.enquiry.createMany({ data: plans.map((p) => p.row) as never });
    const followUps = plans.flatMap((p) => p.followUps.map((f) => ({ tenantId, enquiryId: p.row.id as string, date: f.date, outcomeId: f.outcomeId, note: f.note, nextDate: f.nextDate })));
    if (followUps.length) await db.enquiryFollowUp.createMany({ data: followUps });
    return { enquiries: plans.length, followUps: followUps.length, converted: convertCount };
};
