import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';

/**
 * Demo discipline: about 60 incidents and 20 positive notes this term across the school; VII-B has a
 * few (Shubham Nautiyal one minor late coming, informed, not yet acknowledged, and a positive note);
 * a serious fight in Class IX with a suspension waiting for the principal; one student over the
 * incident limit. Marked is_demo.
 */

let seed = 9_901;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const DAY = 86_400_000;
const DETAILS: Record<string, string[]> = {
    'Late coming': ['Came after the assembly.', 'Reached at 8:20 am.'],
    'Not in uniform': ['No tie and wrong shoes.', 'Came in a coloured sweater.'],
    'Homework not done (repeatedly)': ['Third time this week without homework.'],
    'Mobile phone in class': ['Was using a phone during the maths period; phone kept in the office.'],
    'Misbehaviour in class': ['Disturbed the class repeatedly and argued with the teacher.'],
    'Absent without leave': ['Absent for two days without an application.'],
    'Damage to school property': ['Wrote on the desk with a marker.', 'Broke a window pane while playing.'],
    'Cheating in a test / exam': ['Was found with notes during the unit test.'],
    Bullying: ['Teased a junior student in the bus repeatedly.'],
    Fighting: ['Fight in the playground during the break.'],
    'Helping others': ['Helped a classmate who was unwell reach the sick room.'],
    'Good conduct / leadership': ['Led the class well as monitor during the assembly practice.'],
    'Honesty (returned lost item…)': ['Found a wallet in the corridor and gave it to the office.'],
};

export const createDemoDiscipline = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.incident.count({ where: { isDemo: true } }))) return { incidents: 0, positives: 0 };
    await seedMasters();
    const [types, actions, places] = await Promise.all([
        db.masterValue.findMany({ where: { master: 'incident_type', isActive: true }, select: { id: true, name: true, extra: true } }),
        db.masterValue.findMany({ where: { master: 'discipline_action' }, select: { id: true, name: true } }),
        db.masterValue.findMany({ where: { master: 'incident_place' }, select: { id: true, name: true } }),
    ]);
    const T = (name: string) => types.find((t) => t.name === name)!;
    const A = (name: string) => actions.find((a) => a.name === name)?.id ?? null;
    const P = (name: string) => places.find((p) => p.name === name)?.id ?? null;
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { studentId: true, sectionId: true, section: { select: { name: true, classTeacherId: true, schoolClass: { select: { shortName: true } } } } } });
    const teachers = await db.staff.findMany({ where: { isDemo: true, userId: { not: null } }, select: { id: true, userId: true } });
    const userOfStaff = new Map(teachers.map((t) => [t.id, t.userId!]));
    const principal = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'principal' } } } }, select: { id: true } });
    const start = Math.max(year.startDate.getTime(), Date.now() - 90 * DAY);
    let incidents = 0;
    let positives = 0;

    const make = async (o: { type: string; students: { id: string; role?: string }[]; daysAgo: number; severity?: string; status?: string; title?: string; details?: string; place?: string; informed?: string; ack?: { reply: string | null }; actions?: { name: string; status?: string; studentId?: string | null; from?: string; to?: string; note?: string }[] }) => {
        const t = T(o.type);
        const x = (t.extra ?? {}) as { positive?: boolean; severity?: string; points?: number };
        const positive = !!x.positive;
        const first = enrol.find((e) => e.studentId === o.students[0].id);
        const recorder = (first?.section.classTeacherId && userOfStaff.get(first.section.classTeacherId)) || pick(teachers).userId!;
        const occurred = new Date(Date.parse(`${isoOf(new Date(Date.now() - o.daysAgo * DAY))}T${String(between(8, 13)).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}:00+05:30`));
        const severity = positive ? 'minor' : (o.severity ?? x.severity ?? 'minor');
        const inc = await db.incident.create({
            data: {
                tenantId,
                academicYearId: year.id,
                typeId: t.id,
                positive,
                severity,
                occurredAt: occurred,
                placeId: P(o.place ?? (o.type === 'Late coming' ? 'School gate' : pick(['Classroom', 'Corridor', 'Playground', 'Bus']))),
                title: o.title ?? t.name,
                details: o.details ?? pick(DETAILS[t.name] ?? ['—']),
                status: positive ? 'resolved' : (o.status ?? (rand() < 0.7 ? 'resolved' : 'open')),
                resolvedAt: positive || o.status === 'resolved' ? occurred : null,
                recordedBy: recorder,
                isDemo: true,
                students: {
                    create: o.students.map((s) => {
                        const role = positive ? 'did' : (s.role ?? 'did');
                        const informed = o.informed ?? (positive || severity !== 'minor' ? 'alert' : rand() < 0.3 ? 'phone' : 'none');
                        return { studentId: s.id, sectionId: enrol.find((e) => e.studentId === s.id)?.sectionId ?? null, role, points: role === 'did' ? Number(x.points ?? 0) : 0, informedHow: role === 'witness' ? 'none' : informed, informedAt: informed !== 'none' ? occurred : null, acknowledgedAt: o.ack ? new Date(occurred.getTime() + DAY) : !o.ack && rand() < 0.3 && informed === 'alert' ? new Date(occurred.getTime() + DAY) : null, parentReply: o.ack?.reply ?? null, isDemo: true };
                    }),
                },
            },
        });
        for (const a of o.actions ?? []) await db.incidentAction.create({ data: { tenantId, incidentId: inc.id, studentId: a.studentId ?? null, actionId: A(a.name), note: a.note ?? null, fromDate: a.from ? dayDate(a.from) : null, toDate: a.to ? dayDate(a.to) : null, status: a.status ?? 'done', decidedBy: recorder, approvedBy: a.status === 'pending' ? null : principal?.id ?? null, approvedAt: a.status === 'pending' ? null : occurred, createdAt: occurred, isDemo: true } });
        if (positive) positives++;
        else incidents++;
    };

    // Shubham (VII-B): a minor late coming (informed, not acknowledged) and a positive note.
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    if (shubham) {
        await make({ type: 'Late coming', students: [{ id: shubham.id }], daysAgo: 2, status: 'open', details: 'Reached at 8:25 am, after the assembly. Second time this month.', informed: 'alert' });
        await make({ type: 'Helping others', students: [{ id: shubham.id }], daysAgo: 12, details: 'Helped a new student find his way around the school in his first week.' });
    }
    // A serious fight in Class IX: three students, a suspension waiting for approval.
    const ix = enrol.filter((e) => e.section.schoolClass.shortName === 'IX').map((e) => e.studentId);
    if (ix.length >= 4) {
        const suspendFrom = isoOf(new Date(Date.now() + DAY));
        await make({ type: 'Fighting', students: [{ id: ix[0] }, { id: ix[1] }, { id: ix[2], role: 'affected' }, { id: ix[3], role: 'witness' }], daysAgo: 1, status: 'open', place: 'Playground', title: 'Fight in the playground during the break', details: 'Two students hit a third one during the lunch break; a teacher on duty separated them. The affected student had a small cut on the lip (first aid given).', actions: [{ name: 'Parent meeting', studentId: ix[0] }, { name: 'Suspension', status: 'pending', studentId: ix[0], from: suspendFrom, to: isoOf(new Date(Date.now() + 3 * DAY)), note: 'Second fight this term.' }, { name: 'Written warning', studentId: ix[1] }] });
        // One student over the limit (several incidents in 30 days).
        for (const [type, d] of [['Late coming', 20], ['Mobile phone in class', 14], ['Misbehaviour in class', 6]] as const) await make({ type, students: [{ id: ix[0] }], daysAgo: d, actions: type === 'Mobile phone in class' ? [{ name: 'Parent called' }] : undefined });
    }
    // The rest of the school.
    const negatives = types.filter((t) => !(t.extra as { positive?: boolean } | null)?.positive && t.name !== 'Other').map((t) => t.name);
    const weights = ['Late coming', 'Late coming', 'Late coming', 'Not in uniform', 'Not in uniform', 'Homework not done (repeatedly)', 'Mobile phone in class', 'Misbehaviour in class', ...negatives];
    const days = Math.max(5, Math.floor((Date.now() - start) / DAY));
    for (let i = 0; i < 52; i++) {
        const e = pick(enrol);
        const type = pick(weights);
        await make({ type, students: [{ id: e.studentId }], daysAgo: between(1, days), actions: rand() < 0.5 ? [{ name: pick(['Verbal warning', 'Verbal warning', 'Written warning', 'Parent called', 'Apology letter']) }] : undefined });
    }
    const goods = types.filter((t) => (t.extra as { positive?: boolean } | null)?.positive).map((t) => t.name);
    for (let i = 0; i < 18; i++) await make({ type: pick(goods), students: [{ id: pick(enrol).studentId }], daysAgo: between(1, days) });
    return { incidents, positives };
};

export const clearDemoDiscipline = async () => {
    await db.incident.deleteMany({ where: { isDemo: true } });
};
