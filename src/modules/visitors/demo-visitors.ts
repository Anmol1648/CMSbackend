import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { hashPassword } from '../../core/password';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { schoolDays } from '../attendance/calendar.service';

/**
 * Demo gate: a month of visits (parents, vendors, enquiries, interviews), three visitors inside
 * now and one expected by Deepak Rautela; a blacklisted number; pickup lists for VII-B (Shubham's
 * uncle added by his parents) and two early pickups; the demo security guard with a login.
 * Marked is_demo.
 */

let seed = 7_303;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const PASSWORD = 'Demo@2026';
const FIRST = ['Ramesh', 'Suresh', 'Mohan', 'Dinesh', 'Kailash', 'Prakash', 'Sunil', 'Rajendra', 'Bhupendra', 'Ganesh', 'Meera', 'Lata', 'Savita', 'Kamla', 'Hema', 'Pushpa', 'Anil', 'Vijay', 'Harish', 'Naresh'];
const LAST = ['Negi', 'Rawat', 'Bisht', 'Panwar', 'Bhandari', 'Semwal', 'Dobhal', 'Chauhan', 'Thapliyal', 'Kandari', 'Martolia', 'Sati'];
const VENDORS = ['Himalaya Stationers', 'Joshimath Gas Agency', 'Badri Electricals', 'Garhwal Book Depot', 'Alaknanda Water Supply', 'BlueDart Courier', 'India Post'];

const phone = () => `9${between(100000000, 999999999)}`;
const at = (day: string, h: number, m: number) => new Date(Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`));

export const createDemoVisitors = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.visitor.count({ where: { isDemo: true } }))) return { visits: 0, inside: 0, pickups: 0, guard: null as string | null };
    await seedMasters();
    const masters = await db.masterValue.findMany({ where: { master: { in: ['visit_purpose', 'visitor_id_type', 'pickup_relation'] } }, select: { id: true, master: true, name: true } });
    const m = (master: string, name: string) => masters.find((x) => x.master === master && x.name === name)?.id ?? null;

    // The security guard gets a login with the Security Guard role.
    let role = await db.role.findFirst({ where: { slug: 'security-guard' } });
    role ??= await db.role.create({ data: { tenantId, slug: 'security-guard', name: 'Security Guard', description: 'The gate: visitors in and out, passes, students collected early.' } });
    const des = await db.masterValue.findFirst({ where: { master: 'designation', name: 'Security Guard' }, select: { id: true } });
    const g = des ? await db.staff.findFirst({ where: { isDemo: true, designationId: des.id }, select: { id: true, firstName: true, lastName: true, userId: true } }) : null;
    let guard: string | null = null;
    let guardUser: string | null = null;
    if (g) {
        let userId = g.userId;
        if (!userId) {
            let username = `${g.firstName}.${g.lastName ?? ''}`.toLowerCase().replace(/[^a-z.]/g, '');
            for (let i = 2; await db.user.findFirst({ where: { username } }); i++) username = `${g.firstName}.${g.lastName ?? ''}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
            const u = await db.user.create({ data: { tenantId, kind: 'staff', username, displayName: [g.firstName, g.lastName].filter(Boolean).join(' '), passwordHash: await hashPassword(PASSWORD), mustChangePassword: false, isDemo: true } });
            await db.staff.update({ where: { id: g.id }, data: { userId: u.id } });
            userId = u.id;
        }
        await db.userRole.createMany({ data: [{ tenantId, userId, roleId: role.id }], skipDuplicates: true });
        guard = (await db.user.findFirst({ where: { id: userId }, select: { username: true } }))?.username ?? null;
        guardUser = userId;
    }

    const teachers = await db.staff.findMany({ where: { isDemo: true, status: 'working', userId: { not: null } }, select: { id: true, firstName: true, lastName: true }, take: 40 });
    const deepak = teachers.find((t) => t.firstName === 'Deepak' && t.lastName === 'Rautela');
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', familyId: { not: null } } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { shortName: true } } } }, student: { select: { familyId: true } } }, take: 400 });
    const guardians = await db.guardian.findMany({ where: { familyId: { in: enrol.map((e) => e.student.familyId!) } }, select: { familyId: true, name: true, mobile: true } });

    // Visitor people: some regulars (vendors, parents) come more than once.
    const people: { id: string; name: string; mobile: string; kind: 'parent' | 'vendor' | 'other'; studentId?: string }[] = [];
    for (let i = 0; i < 25; i++) {
        const e = pick(enrol);
        const gd = guardians.find((x) => x.familyId === e.student.familyId);
        if (!gd) continue;
        const v = await db.visitor.create({ data: { tenantId, name: gd.name, mobile: gd.mobile ?? phone(), idTypeId: rand() < 0.5 ? m('visitor_id_type', 'Aadhaar card') : null, isDemo: true } });
        people.push({ id: v.id, name: v.name, mobile: v.mobile!, kind: 'parent', studentId: e.studentId });
    }
    for (const name of VENDORS) {
        const v = await db.visitor.create({ data: { tenantId, name: `${pick(FIRST)} ${pick(LAST)} (${name})`, mobile: phone(), idTypeId: m('visitor_id_type', 'Company ID card'), isDemo: true } });
        people.push({ id: v.id, name: v.name, mobile: v.mobile!, kind: 'vendor' });
    }
    for (let i = 0; i < 15; i++) {
        const v = await db.visitor.create({ data: { tenantId, name: `${pick(FIRST)} ${pick(LAST)}`, mobile: phone(), idTypeId: rand() < 0.4 ? m('visitor_id_type', 'Driving licence') : null, isDemo: true } });
        people.push({ id: v.id, name: v.name, mobile: v.mobile!, kind: 'other' });
    }
    const black = await db.visitor.create({ data: { tenantId, name: 'Raju Kumar', mobile: '9800000013', blacklisted: true, blacklistReason: 'Misbehaved with staff on 2 Oct; entry not allowed', isDemo: true } });

    // A month of visits on school days.
    const today = todayIST();
    const days = await schoolDays(isoOf(new Date(dayDate(today).getTime() - 30 * 86_400_000)), isoOf(new Date(dayDate(today).getTime() - 86_400_000)), 'staff');
    let visits = 0;
    let n = 0;
    const visit = async (day: string, p: (typeof people)[number], status: 'in' | 'out', inH: number, inM: number, stay: number) => {
        const purpose = p.kind === 'vendor' ? pick(['Delivery / courier', 'Vendor / contractor']) : p.kind === 'parent' ? pick(['Parent: about my child', 'Parent: about my child', 'Fees / office work', 'Meet a teacher']) : pick(['Admission enquiry', 'Interview', 'Official visit / inspection', 'Other', 'Meet a teacher']);
        const hostKind = purpose === 'Meet a teacher' || purpose === 'Interview' ? 'staff' : purpose === 'Parent: about my child' ? 'student' : 'office';
        const inAt = at(day, inH, inM);
        n++;
        await db.visit.create({ data: { tenantId, visitorId: p.id, passNo: `VP-${day.replace(/-/g, '').slice(2)}-${String(n % 1000).padStart(3, '0')}`, day: dayDate(day), purposeId: m('visit_purpose', purpose), hostKind, staffId: hostKind === 'staff' ? pick(teachers).id : null, studentId: hostKind === 'student' ? (p.studentId ?? pick(enrol).studentId) : null, people: rand() < 0.2 ? 2 : 1, vehicleNo: rand() < 0.3 ? `UK07 ${pick(['A', 'B', 'C', 'T'])}${pick(['A', 'B', 'K'])} ${between(1000, 9999)}` : null, status, inAt, outAt: status === 'out' ? new Date(inAt.getTime() + stay * 60_000) : null, createdBy: guardUser, checkedOutBy: status === 'out' ? guardUser : null, isDemo: true } });
        await db.visitor.update({ where: { id: p.id }, data: { lastVisitAt: inAt } });
        visits++;
    };
    for (const day of days) for (let i = between(3, 8); i > 0; i--) await visit(day, pick(people), 'out', between(8, 13), between(0, 59), between(8, 70));

    // Today: some came and went, three inside now; one expected by Deepak Rautela.
    await visit(today, pick(people.filter((p) => p.kind === 'vendor')), 'out', 8, 40, 15);
    for (const p of [pick(people.filter((x) => x.kind === 'parent')), pick(people.filter((x) => x.kind === 'vendor')), pick(people.filter((x) => x.kind === 'other'))]) await visit(today, p, 'in', 9, between(5, 55), 0);
    if (deepak) {
        const exp = await db.visitor.create({ data: { tenantId, name: 'Dr. Anita Sati', mobile: '9412000221', isDemo: true } });
        await db.visit.create({ data: { tenantId, visitorId: exp.id, day: dayDate(today), purposeId: m('visit_purpose', 'Meet a teacher'), hostKind: 'staff', staffId: deepak.id, people: 1, note: 'Guest talk for Class VII on Hindi poetry', status: 'expected', createdBy: (await db.staff.findFirst({ where: { id: deepak.id }, select: { userId: true } }))?.userId ?? null, isDemo: true } });
    }
    // The blacklisted man was turned away last week.
    if (days.length) await db.visit.create({ data: { tenantId, visitorId: black.id, day: dayDate(days[days.length - 4] ?? days[0]), purposeId: m('visit_purpose', 'Other'), hostKind: 'office', status: 'denied', answerNote: 'Blacklisted: not allowed in', isDemo: true } });

    // Pickup lists for VII-B, and two early pickups.
    const viiB = enrol.filter((e) => e.section.name === 'B' && e.section.schoolClass.shortName === 'VII').map((e) => e.studentId);
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true, familyId: true } });
    const parentUser = shubham?.familyId ? (await db.guardian.findFirst({ where: { familyId: shubham.familyId, userId: { not: null } }, select: { userId: true } }))?.userId ?? null : null;
    if (shubham) await db.pickupPerson.create({ data: { tenantId, studentId: shubham.id, name: 'Rakesh Nautiyal', relationId: m('pickup_relation', 'Uncle'), mobile: '9456112233', note: 'Collects on Saturdays', addedBy: parentUser, isDemo: true } });
    for (const sid of viiB.slice(0, 6)) if (sid !== shubham?.id) await db.pickupPerson.create({ data: { tenantId, studentId: sid, name: `${pick(FIRST)} ${pick(LAST)}`, relationId: m('pickup_relation', pick(['Grandfather', 'Uncle', 'Aunt', 'Family driver'])), mobile: phone(), isDemo: true } });
    let pickups = 0;
    if (shubham && days.length > 5) {
        const father = shubham.familyId ? await db.guardian.findFirst({ where: { familyId: shubham.familyId }, orderBy: { isPrimary: 'desc' }, select: { id: true, name: true, mobile: true, relation: { select: { name: true } } } }) : null;
        if (father) {
            await db.studentPickup.create({ data: { tenantId, studentId: shubham.id, byKind: 'guardian', guardianId: father.id, name: father.name, relation: father.relation?.name ?? 'Father', mobile: father.mobile, reason: 'Doctor’s appointment', status: 'done', at: at(days[days.length - 5], 11, 20), createdBy: guardUser, isDemo: true } });
            pickups++;
        }
    }
    const other = viiB.find((s) => s !== shubham?.id);
    if (other && days.length > 2) {
        await db.studentPickup.create({ data: { tenantId, studentId: other, byKind: 'other', name: 'Sohan Rawat', relation: 'Cousin', mobile: phone(), reason: 'Family function', status: 'refused', at: at(days[days.length - 2], 12, 5), createdBy: guardUser, isDemo: true } });
        pickups++;
    }
    return { visits, inside: 3, pickups, guard };
};

export const clearDemoVisitors = async () => {
    await db.studentPickup.deleteMany({ where: { isDemo: true } });
    await db.pickupPerson.deleteMany({ where: { isDemo: true } });
    await db.visit.deleteMany({ where: { isDemo: true } });
    await db.visitor.deleteMany({ where: { isDemo: true } });
};
