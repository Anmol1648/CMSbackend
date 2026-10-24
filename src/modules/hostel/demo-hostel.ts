import { randomBytes } from 'crypto';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { hashPassword } from '../../core/password';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { allocateEmployeeCode } from '../staff/staff.service';

/**
 * Demo hostel: a boys' and a girls' hostel (~20 rooms of four room types), ~60 boarders (Shubham
 * Nautiyal and the demo parent's children among them, from the start of the session so the hostel
 * fee is in their instalments), wardens with logins, a week of night roll calls, leave (one pending,
 * one approved, one out now, one overdue, returned on time and late), sick-bay visits, inspections,
 * fines and allowed visitors. Marked is_demo.
 */

let seed = 7_171;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const PASSWORD = 'Demo@2026';
const code = () => randomBytes(4).toString('hex').toUpperCase();

const ROOMS: { hostel: 0 | 1; floor: number; numbers: number[]; type: string; beds: number }[] = [
    { hostel: 0, floor: 1, numbers: [101, 102, 103, 104, 105, 106], type: 'Four-seater', beds: 4 },
    { hostel: 0, floor: 2, numbers: [201, 202], type: 'Dormitory', beds: 8 },
    { hostel: 0, floor: 2, numbers: [203, 204], type: 'Two-seater', beds: 2 },
    { hostel: 1, floor: 1, numbers: [101, 102, 103, 104], type: 'Four-seater', beds: 4 },
    { hostel: 1, floor: 1, numbers: [105, 106], type: 'Two-seater with AC', beds: 2 },
    { hostel: 1, floor: 2, numbers: [201, 202], type: 'Dormitory', beds: 6 },
];

const COMPLAINTS: [string, string, string][] = [
    ['Fever (100.4°F)', 'Rest in the sick bay', 'Paracetamol 500 mg'],
    ['Stomach ache', 'Light food, ORS', 'ORS sachet'],
    ['Cut on the knee (football)', 'Cleaned and dressed', 'Betadine'],
    ['Headache', 'Rest', 'Paracetamol 500 mg'],
    ['Cold and cough', 'Steam, warm water', 'Cough syrup'],
];

/**
 * A demo staff member with a login and a role: one without a login if there is one, else a new
 * person (the demo staff all have logins once the other demos have run).
 */
export const demoStaffWithLogin = async (role: { id: string }, make: { firstName: string; lastName: string; female: boolean; department: string; designation: string }, where: object = {}) => {
    const tenantId = getTenantId()!;
    let s = await db.staff.findFirst({ where: { isDemo: true, userId: null, status: 'working', ...where }, orderBy: { employeeCode: 'desc' }, select: { id: true, firstName: true, lastName: true } });
    if (!s) {
        const mv = await db.masterValue.findMany({ where: { master: { in: ['gender', 'department', 'designation', 'staff_type'] } }, select: { id: true, name: true, master: true } });
        const m = (master: string, name: string) => mv.find((x) => x.master === master && x.name.toLowerCase().startsWith(name.toLowerCase()))?.id ?? null;
        const joining = new Date(Date.now() - 400 * DAY);
        s = await db.staff.create({ data: { tenantId, employeeCode: await allocateEmployeeCode(joining), joiningDate: dayDate(isoOf(joining)), firstName: make.firstName, lastName: make.lastName, genderId: m('gender', make.female ? 'Female' : 'Male'), mobile: `9${Math.floor(100000000 + rand() * 899999999)}`, departmentId: m('department', make.department), designationId: m('designation', make.designation), staffTypeId: m('staff_type', 'Non-teaching'), isDemo: true }, select: { id: true, firstName: true, lastName: true } });
    }
    let username = `${s.firstName}.${s.lastName ?? ''}`.toLowerCase().replace(/[^a-z.]/g, '');
    for (let i = 2; await db.user.findFirst({ where: { username } }); i++) username = `${s.firstName}.${s.lastName ?? ''}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const u = await db.user.create({ data: { tenantId, kind: 'staff', username, displayName: [s.firstName, s.lastName].filter(Boolean).join(' '), passwordHash: await hashPassword(PASSWORD), mustChangePassword: false, isDemo: true } });
    await db.staff.update({ where: { id: s.id }, data: { userId: u.id } });
    await db.userRole.createMany({ data: [{ tenantId, userId: u.id, roleId: role.id }], skipDuplicates: true });
    return { staffId: s.id, userId: u.id, username };
};

export const createDemoHostel = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.hostel.count({ where: { isDemo: true } }))) return { hostels: 0, boarders: 0, wardens: [] as string[] };
    await seedMasters();
    for (const [master, name, c, extra] of [['notification_type', 'Hostel', 'hostel', { icon: 'bed' }], ['fee_head', 'Hostel fee', 'HOSTEL', { one_time: false, refundable: false }]] as const)
        if (!(await db.masterValue.findFirst({ where: { master, code: c } }))) await db.masterValue.create({ data: { tenantId, master, name, code: c, sortOrder: 98, extra } });
    const types = await db.masterValue.findMany({ where: { master: 'hostel_room_type' }, select: { id: true, name: true } });
    const typeId = (name: string) => types.find((t) => t.name.startsWith(name))?.id ?? null;

    // Wardens: two demo staff without a login get one, with the Hostel Warden role.
    let role = await db.role.findFirst({ where: { slug: 'warden' } });
    role ??= await db.role.create({ data: { tenantId, slug: 'warden', name: 'Hostel Warden', description: 'Runs their hostel: night roll call, leave passes, sick bay, inspections and fines.' } });
    const genders = await db.masterValue.findMany({ where: { master: 'gender' }, select: { id: true, name: true } });
    const male = genders.find((g) => g.name.toLowerCase().startsWith('m'))?.id;
    const female = genders.find((g) => g.name.toLowerCase().startsWith('f'))?.id;
    const wardens: { staffId: string; userId: string; username: string }[] = [];
    wardens.push(await demoStaffWithLogin(role, { firstName: 'Harish', lastName: 'Negi', female: false, department: 'Admin', designation: 'Sub Staff' }, male ? { genderId: male } : {}));
    wardens.push(await demoStaffWithLogin(role, { firstName: 'Kamla', lastName: 'Rawat', female: true, department: 'Admin', designation: 'Sub Staff' }, female ? { genderId: female } : {}));

    const hostels = [
        await db.hostel.create({ data: { tenantId, name: 'Nanda Devi House', gender: 'boys', wardenId: wardens[0]?.staffId ?? null, phone: '01389-222411', isDemo: true } }),
        await db.hostel.create({ data: { tenantId, name: 'Bhagirathi House', gender: 'girls', wardenId: wardens[1]?.staffId ?? wardens[0]?.staffId ?? null, phone: '01389-222412', isDemo: true } }),
    ];
    for (const r of ROOMS)
        await db.hostelRoom.createMany({ data: r.numbers.map((n) => ({ tenantId, hostelId: hostels[r.hostel].id, block: r.hostel ? 'B' : 'A', floor: r.floor, number: String(n), roomTypeId: typeId(r.type), beds: r.beds, isDemo: true })) });
    const rooms = await db.hostelRoom.findMany({ where: { hostelId: { in: hostels.map((h) => h.id) } }, orderBy: { number: 'asc' } });

    // Boarders: the sample student and the demo parent's children first, then others by gender.
    const parent = await db.user.findFirst({ where: { username: '9373993122' }, select: { id: true } });
    const first = await db.student.findMany({ where: { status: 'active', OR: [{ admissionNo: '2025/0235' }, ...(parent ? [{ family: { guardians: { some: { userId: parent.id } } } }] : [])] }, select: { id: true, genderId: true } });
    const enrolled = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', isDemo: true } }, select: { studentId: true, student: { select: { genderId: true } } }, orderBy: { studentId: 'asc' } });
    const pool = enrolled.filter((e) => !first.some((f) => f.id === e.studentId) && rand() < 0.5);
    const boys = [...first.filter((f) => f.genderId !== female).map((f) => f.id), ...pool.filter((e) => e.student.genderId !== female).map((e) => e.studentId)];
    const girls = [...first.filter((f) => f.genderId === female).map((f) => f.id), ...pool.filter((e) => e.student.genderId === female).map((e) => e.studentId)];
    const from = year.startDate;
    const createdBy = (await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } }))?.id ?? null;
    const allots: { studentId: string; hostelId: string; roomId: string; bed: number }[] = [];
    for (const [h, list] of [[0, boys], [1, girls]] as const) {
        const beds = rooms.filter((r) => r.hostelId === hostels[h].id).flatMap((r) => Array.from({ length: r.beds }, (_, i) => ({ roomId: r.id, bed: i + 1 })));
        // Leave about one bed in eight empty.
        const take = Math.min(list.length, Math.floor(beds.length * 0.88));
        for (let i = 0; i < take; i++) allots.push({ studentId: list[i], hostelId: hostels[h].id, ...beds[i] });
    }
    await db.hostelAllotment.createMany({ data: allots.map((a) => ({ tenantId, ...a, academicYearId: year.id, fromDate: from, createdBy, isDemo: true })) });
    // One boarder who left the hostel last month.
    const old = pool.find((e) => !allots.some((a) => a.studentId === e.studentId) && e.student.genderId !== female);
    const spare = rooms.find((r) => r.hostelId === hostels[0].id && r.beds === 8);
    if (old && spare) await db.hostelAllotment.create({ data: { tenantId, studentId: old.studentId, academicYearId: year.id, hostelId: hostels[0].id, roomId: spare.id, bed: 8, fromDate: from, toDate: new Date(Date.now() - 35 * DAY), status: 'vacated', note: 'Became a day scholar', createdBy, isDemo: true } });

    const today = todayIST();
    const sample = first[0]?.id ?? allots[0]?.studentId;
    const of = (h: number) => allots.filter((a) => a.hostelId === hostels[h].id).map((a) => a.studentId);
    const wardenUser = (h: number) => wardens[h]?.userId ?? wardens[0]?.userId ?? null;

    // Leave: [student, from (hours from now), to, status, outAt, inAt, late, reason, by parent]
    const boysList = of(0).filter((id) => id !== sample);
    const girlsList = of(1);
    const leaves: [string | undefined, number, number, string, number | null, number | null, boolean, string, boolean][] = [
        [sample, -8 * 24, -6 * 24, 'returned', -8 * 24 + 0.3, -6 * 24 - 0.5, false, 'Cousin’s wedding at Gopeshwar', true],
        [sample, 2 * 24 + 6, 4 * 24 + 6, 'approved', null, null, false, 'Diwali at home', true],
        [boysList[0], -20, 30, 'out', -19.8, null, false, 'Dentist appointment in Dehradun', false],
        [boysList[1], -30, -3, 'out', -29.5, null, false, 'Grandmother unwell', true],
        [girlsList[0], -5 * 24, -3 * 24, 'returned', -5 * 24 + 0.2, -3 * 24 + 2.5, true, 'Family function', true],
        [girlsList[1], 24, 3 * 24, 'pending', null, null, false, 'Sister’s engagement', true],
        [boysList[2], 26, 28, 'pending', null, null, false, 'Medical check-up', true],
        [girlsList[2], -12 * 24, -11 * 24, 'rejected', null, null, false, 'Outing with friends', true],
    ];
    const now = Date.now();
    for (const [studentId, f, t, status, outAt, inAt, late, reason, byParent] of leaves) {
        if (!studentId) continue;
        const a = allots.find((x) => x.studentId === studentId)!;
        const h = a.hostelId === hostels[0].id ? 0 : 1;
        await db.hostelLeave.create({ data: { tenantId, studentId, hostelId: a.hostelId, fromAt: new Date(now + f * HOUR), toAt: new Date(now + t * HOUR), reason, escort: byParent ? 'Father' : 'Warden’s staff', destination: byParent ? 'Home' : 'Dehradun', status, passCode: code(), requestedBy: byParent ? (parent?.id ?? null) : wardenUser(h), answeredBy: status === 'pending' ? null : wardenUser(h), answeredAt: status === 'pending' ? null : new Date(now + (f - 20) * HOUR), answer: status === 'rejected' ? 'Outings only with parents' : null, outAt: outAt !== null ? new Date(now + outAt * HOUR) : null, inAt: inAt !== null ? new Date(now + inAt * HOUR) : null, late, isDemo: true } });
    }

    // A week of night roll calls (not tonight's: the warden takes it).
    const awayIds = new Set([boysList[0], boysList[1]]);
    for (let d = 7; d >= 1; d--) {
        const date = isoOf(new Date(dayDate(today).getTime() - d * DAY));
        for (let h = 0; h < 2; h++) {
            const marks: Record<string, string> = {};
            for (const id of of(h)) marks[id] = rand() < 0.012 ? 'absent' : 'present';
            if (d === 1) for (const id of awayIds) if (marks[id]) marks[id] = 'leave';
            if (sample && marks[sample] && d >= 6) marks[sample] = 'leave';
            await db.hostelRollCall.create({ data: { tenantId, hostelId: hostels[h].id, date: dayDate(date), marks, takenBy: wardenUser(h), takenAt: new Date(dayDate(date).getTime() + 21 * HOUR - 5.5 * HOUR + 10 * 60_000), isDemo: true } });
        }
    }

    // Sick bay, inspections, fines, visitors.
    const sick = [sample, boysList[3], girlsList[3], boysList[4], girlsList[4]];
    for (let i = 0; i < sick.length; i++) {
        const id = sick[i];
        if (!id) continue;
        const [complaint, treatment, medicine] = COMPLAINTS[i % COMPLAINTS.length];
        await db.hostelMedical.create({ data: { tenantId, studentId: id, hostelId: allots.find((a) => a.studentId === id)?.hostelId ?? null, at: new Date(now - (3 + i * 4) * DAY + 20 * HOUR), complaint, treatment, medicine, referred: i === 3, parentTold: true, recordedBy: wardenUser(0), isDemo: true } });
    }
    const roomOf = (id?: string) => allots.find((a) => a.studentId === id)?.roomId ?? null;
    const notes = [
        { h: 0, roomId: rooms.find((r) => r.hostelId === hostels[0].id)?.id ?? null, studentId: null, kind: 'inspection', note: 'Room tidy, beds made. Window latch loose: told maintenance.', fine: null, ago: 9 },
        { h: 1, roomId: rooms.find((r) => r.hostelId === hostels[1].id)?.id ?? null, studentId: null, kind: 'inspection', note: 'All in order.', fine: null, ago: 9 },
        { h: 0, roomId: roomOf(sample), studentId: sample, kind: 'fine', note: 'Mobile phone found after lights-out', fine: 500, ago: 12 },
        { h: 0, roomId: roomOf(boysList[5]), studentId: boysList[5], kind: 'fine', note: 'Broke the study-table lamp', fine: 350, ago: 4 },
    ];
    for (const n of notes) if (n.kind === 'inspection' || n.studentId) await db.hostelNote.create({ data: { tenantId, hostelId: hostels[n.h].id, roomId: n.roomId, studentId: n.studentId ?? null, academicYearId: year.id, kind: n.kind, note: n.note, fine: n.fine, at: new Date(now - n.ago * DAY), recordedBy: wardenUser(n.h), isDemo: true } });
    if (sample)
        await db.hostelVisitorAllow.createMany({ data: [{ tenantId, studentId: sample, name: 'Rakesh Nautiyal', relation: 'Uncle', phone: '9410012345', addedBy: parent?.id ?? null, isDemo: true }, { tenantId, studentId: sample, name: 'Sunita Nautiyal', relation: 'Aunt', phone: '9410012346', addedBy: parent?.id ?? null, isDemo: true }] });

    return { hostels: hostels.length, boarders: allots.length, wardens: wardens.map((w) => w.username) };
};

export const clearDemoHostel = async () => {
    await db.hostelNote.deleteMany({ where: { isDemo: true } });
    await db.hostelMedical.deleteMany({ where: { isDemo: true } });
    await db.hostelVisitorAllow.deleteMany({ where: { isDemo: true } });
    await db.hostelLeave.deleteMany({ where: { isDemo: true } });
    await db.hostelRollCall.deleteMany({ where: { isDemo: true } });
    await db.hostelAllotment.deleteMany({ where: { isDemo: true } });
    await db.hostelRoom.deleteMany({ where: { isDemo: true } });
    await db.hostel.deleteMany({ where: { isDemo: true } });
};
