import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { daysOff, schoolDays } from '../attendance/calendar.service';
import { statuses } from '../attendance/student-attendance.service';
import { eligible, leaveTypes } from './leave-types.service';
import { leaveDays } from './staff-leave.service';
import { leaveYearOf } from './balances.service';

/**
 * Demo staff leave: this year's leave of the demo staff (approved, not approved, cancelled), a few
 * waiting for approval, a couple away today, some comp-offs and opening balances. Marked is_demo.
 */

let seed = 7_331;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));

const REASONS: Record<string, string[]> = {
    CL: ['Family function', 'Personal work at the bank', 'Going home to the village', 'Child’s school event', 'House shifting'],
    SL: ['Fever and cold', 'Viral infection, doctor advised rest', 'Stomach upset', 'Back pain', 'Migraine'],
    EL: ['Family trip', 'Sister’s wedding', 'Going to Haridwar with parents'],
    OD: ['Board exam duty at Gopeshwar', 'Training at the district office', 'Sports meet with the students'],
    LWP: ['Personal reasons'],
    CO: ['Taking the comp-off for the Sunday worked'],
};

export const createDemoLeave = async () => {
    const tenantId = getTenantId()!;
    const today = todayIST();
    const year = await leaveYearOf(today);
    const types = (await leaveTypes()).filter((t) => t.isActive);
    const byCode = new Map(types.map((t) => [t.code, t]));
    const staff = await db.staff.findMany({
        where: { isDemo: true, status: 'working' },
        select: { id: true, joiningDate: true, staffTypeId: true, employmentTypeId: true, genderId: true, reportsTo: { select: { userId: true } } },
    });
    const approver = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'principal' } } } }, select: { id: true } });
    const list = (await statuses()).filter((s) => s.isActive);
    const statusOf = (code: string) => (list.find((s) => s.code.toUpperCase() === code.toUpperCase()) ?? list.find((s) => s.code === 'LV'))?.id ?? null;
    let leaves = 0;
    let attendance = 0;

    const add = async (s: (typeof staff)[number], code: string, from: string, length: number, status: 'approved' | 'pending' | 'rejected' | 'cancelled', half: 'first' | 'second' | null = null) => {
        const t = byCode.get(code);
        if (!t || !eligible(t, s)) return;
        const to = half ? from : addDays(from, length - 1);
        const { days, working } = await leaveDays(t, from, to, half);
        if (!days) return;
        const clash = await db.staffLeave.findFirst({ where: { staffId: s.id, status: { in: ['approved', 'pending'] }, fromDate: { lte: dayDate(to) }, toDate: { gte: dayDate(from) } }, select: { id: true } });
        if (clash) return;
        const decider = s.reportsTo?.userId ?? approver?.id ?? null;
        await db.staffLeave.create({
            data: {
                tenantId,
                staffId: s.id,
                leaveTypeId: t.id,
                fromDate: dayDate(from),
                toDate: dayDate(to),
                half,
                days,
                reason: pick(REASONS[code] ?? ['Personal work']),
                status,
                stage: status === 'pending' ? (s.reportsTo?.userId ? 1 : 2) : 2,
                createdAt: new Date(dayDate(from).getTime() - (2 + Math.floor(rand() * 5)) * DAY),
                ...(status === 'approved' || status === 'rejected' ? { decidedBy: decider, decidedAt: new Date(dayDate(from).getTime() - DAY), decisionNote: status === 'rejected' ? 'Exams that week, please choose other dates' : null } : {}),
                isDemo: true,
            },
        });
        leaves++;
        if (status !== 'approved') return;
        // The register shows the leave on those days (the demo check-ins of those days go).
        const label = `${t.name}${half ? ` (${half} half)` : ''}`;
        if (!half) await db.staffAttendance.deleteMany({ where: { staffId: s.id, date: { in: working.map(dayDate) }, isDemo: true } });
        const rows = half ? [] : working.map((d) => ({ tenantId, staffId: s.id, date: dayDate(d), statusId: statusOf(t.attendanceCode), source: 'leave', note: label, isDemo: true }));
        if (rows.length) attendance += (await db.staffAttendance.createMany({ data: rows, skipDuplicates: true })).count;
    };

    const past = await schoolDays(year.start > addDays(today, -150) ? year.start : addDays(today, -150), addDays(today, -1), 'staff');
    for (const s of staff) {
        // Two or three leaves already taken this year, sometimes one turned down.
        for (let i = 0; i < 2 + Math.floor(rand() * 2); i++) {
            if (!past.length) break;
            const r = rand();
            const code = r < 0.5 ? 'CL' : r < 0.8 ? 'SL' : r < 0.9 ? 'OD' : 'EL';
            await add(s, code, pick(past), code === 'CL' ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3), rand() < 0.08 ? 'rejected' : 'approved', code === 'CL' && rand() < 0.15 ? 'first' : null);
        }
        if (rand() < 0.05 && past.length) await add(s, 'LWP', pick(past), 1, 'approved');
    }
    // Waiting for approval (the coming two weeks), and two people away today.
    const coming = await schoolDays(addDays(today, 1), addDays(today, 14), 'staff');
    for (const s of staff.slice(0, 8)) if (coming.length) await add(s, pick(['CL', 'CL', 'EL', 'SL']), pick(coming), 1 + Math.floor(rand() * 2), 'pending');
    for (const s of staff.slice(8, 10)) await add(s, 'CL', today, 1, 'approved');
    for (const s of staff.slice(10, 12)) if (coming.length) await add(s, 'CL', pick(coming), 1, 'cancelled');

    // Comp-offs for a recent day off worked, and opening balances carried from before.
    const offs = [...(await daysOff(addDays(today, -40), addDays(today, -1), 'staff')).keys()];
    const co = byCode.get('CO');
    let compOffs = 0;
    if (co && offs.length) {
        for (const s of staff.slice(12, 15)) {
            const d = pick(offs);
            await db.leaveEntry.create({ data: { tenantId, staffId: s.id, leaveTypeId: co.id, yearStart: dayDate((await leaveYearOf(d)).start), kind: 'compoff', days: 1, workedOn: dayDate(d), expiresOn: co.compOffDays ? dayDate(addDays(d, co.compOffDays)) : null, note: 'Annual day preparation', isDemo: true } });
            compOffs++;
        }
    }
    const el = byCode.get('EL');
    if (el) {
        const data = staff
            .slice(0, 12)
            .filter((s) => isoOf(s.joiningDate) < year.start)
            .map((s) => ({ tenantId, staffId: s.id, leaveTypeId: el.id, yearStart: dayDate(year.start), kind: 'carry', days: 5 + Math.floor(rand() * 15), note: 'Opening balance from the old register', isDemo: true }));
        if (data.length) await db.leaveEntry.createMany({ data });
    }
    return { leaves, attendance, compOffs };
};

export const clearDemoLeave = async () => {
    await db.staffAttendance.deleteMany({ where: { isDemo: true, source: 'leave' } });
    await db.leaveEntry.deleteMany({ where: { isDemo: true } });
    return (await db.staffLeave.deleteMany({ where: { isDemo: true } })).count;
};
