import { db } from '../../core/db';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { statuses, viewableSections } from '../attendance/student-attendance.service';
import { hostelScope } from '../hostel/hostel.service';
import { kitchenCost, meals } from '../mess/mess.service';
import { defineDefaultLayout, defineWidget, dropFromDefaultLayouts, extendDefaultLayout, ListData } from './dashboard.registry';

/**
 * Dashboard v2 widgets: trends (fees by month, attendance), birthdays, hostel and mess, salary bill,
 * stock value, and each person's quick links; and what each role's built-in dashboard adds.
 */

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const showDay = (iso: string, o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
const PERIODS = [
    { value: '7', label: 'Last 7 days' },
    { value: '30', label: 'Last 30 days' },
    { value: '90', label: 'Last 90 days' },
];
const period = (f: string | undefined, def = '30') => (PERIODS.some((p) => p.value === f) ? f! : def);

// ─── Fees ────────────────────────────────────────────────────────────────────

defineWidget({
    key: 'fee_monthly',
    label: 'Fees by month',
    description: 'Fees received in each month of this session, with the same month last session.',
    category: 'Fees',
    type: 'chart',
    size: 'md',
    href: '/fees/reports',
    permissions: ['fee.reports'],
    cacheSeconds: 900,
    async load() {
        const year = await currentYear();
        if (!year) return { hidden: true, kind: 'bar', points: [] };
        const prev = await db.academicYear.findFirst({ where: { startDate: { lt: year.startDate } }, orderBy: { startDate: 'desc' }, select: { startDate: true } });
        const from = prev?.startDate ?? year.startDate;
        const rows = await db.feeReceipt.findMany({ where: { status: 'active', date: { gte: from, lte: year.endDate } }, select: { date: true, amount: true } });
        const by = new Map<string, number>();
        for (const r of rows) by.set(isoOf(r.date).slice(0, 7), (by.get(isoOf(r.date).slice(0, 7)) ?? 0) + r.amount);
        const points = [];
        const thisMonth = todayIST().slice(0, 7);
        let total = 0;
        let lastTotal = 0;
        for (let i = 0; i < 12; i++) {
            const d = new Date(year.startDate);
            d.setUTCMonth(d.getUTCMonth() + i);
            const ym = d.toISOString().slice(0, 7);
            if (ym > thisMonth) break;
            const ly = new Date(d);
            ly.setUTCFullYear(ly.getUTCFullYear() - 1);
            const last = by.get(ly.toISOString().slice(0, 7)) ?? 0;
            const v = by.get(ym) ?? 0;
            total += v;
            lastTotal += last;
            points.push({ label: monthLabel(ym), value: v, hint: `${monthLabel(ym)}: ${rupees(v)} · last session ${rupees(last)}` });
        }
        const diff = lastTotal ? Math.round(((total - lastTotal) / lastTotal) * 100) : null;
        return { kind: 'bar', points, money: true, caption: `${rupees(total)} this session${diff !== null ? ` · ${diff >= 0 ? '+' : ''}${diff}% on the same months last session` : ''}` };
    },
});

// ─── Attendance ──────────────────────────────────────────────────────────────

defineWidget({
    key: 'attendance_trend',
    label: 'Attendance trend',
    description: 'Students present each school day (% of those marked), for the sections the person may see.',
    category: 'Today',
    type: 'chart',
    size: 'md',
    href: '/attendance',
    permissions: ['attendance.view', 'attendance.mark_any'],
    cacheSeconds: 900,
    async load({ userId, filter }) {
        const days = Number(period(filter));
        const t = todayIST();
        const from = addDays(t, -(days - 1));
        const scope = await viewableSections(userId);
        const sheets = await db.attendanceSheet.findMany({ where: { date: { gte: dayDate(from), lte: dayDate(t) }, ...(scope === 'all' ? {} : { sectionId: { in: scope } }) }, select: { id: true, date: true } });
        const [groups, st] = await Promise.all([db.attendanceMark.groupBy({ by: ['sheetId', 'statusId'], where: { sheetId: { in: sheets.map((s) => s.id) } }, _count: { _all: true } }), statuses()]);
        const presentOf = new Map(st.map((s) => [s.id, s.present]));
        const dateOf = new Map(sheets.map((s) => [s.id, isoOf(s.date)]));
        const by = new Map<string, { p: number; n: number }>();
        for (const g of groups) {
            const d = dateOf.get(g.sheetId)!;
            const x = by.get(d) ?? { p: 0, n: 0 };
            x.p += (presentOf.get(g.statusId) ?? 0) * g._count._all;
            x.n += g._count._all;
            by.set(d, x);
        }
        const points = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, x]) => ({ label: showDay(d), value: Math.round((x.p / x.n) * 1000) / 10, hint: `${showDay(d, { weekday: 'short', day: 'numeric', month: 'short' })}: ${Math.round((x.p / x.n) * 1000) / 10}% of ${x.n}` }));
        const avg = points.length ? Math.round((points.reduce((a, p) => a + p.value, 0) / points.length) * 10) / 10 : null;
        return { kind: 'line', points, caption: avg !== null ? `Average ${avg}% over ${points.length} school days` : 'No attendance marked in this period', filter: { value: String(days), options: PERIODS } };
    },
});

// ─── People ──────────────────────────────────────────────────────────────────

defineWidget({
    key: 'birthdays_today',
    label: 'Birthdays today',
    description: 'Students (of the sections the person may see) and staff whose birthday is today.',
    category: 'Today',
    type: 'list',
    size: 'sm',
    permissions: ['student.view', 'staff.view', 'attendance.checkin'],
    cacheSeconds: 3600,
    async load({ userId, permissions: p }) {
        const md = todayIST().slice(5);
        const year = await currentYear();
        const items: ListData['items'] = [];
        if (p['student.view'] && year) {
            let sections: string[] | 'all' = 'all';
            if (p['student.view'] !== 'all') {
                const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
                sections = staff ? [...new Set([...(await db.teachingAssignment.findMany({ where: { academicYearId: year.id, staffId: staff.id }, select: { sectionId: true } })).map((x) => x.sectionId), ...(await db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id }, select: { id: true } })).map((x) => x.id)])] : [];
            }
            const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', dateOfBirth: { not: null } }, ...(sections === 'all' ? {} : { sectionId: { in: sections } }) }, select: { student: { select: { firstName: true, middleName: true, lastName: true, dateOfBirth: true } }, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } });
            for (const e of enrol) if (isoOf(e.student.dateOfBirth!).slice(5) === md) items.push({ title: fullName(e.student), sub: sectionLabel(e.section), badge: '🎂' });
        }
        const staff = await db.staff.findMany({ where: { status: 'working', dateOfBirth: { not: null } }, select: { firstName: true, middleName: true, lastName: true, dateOfBirth: true, designation: { select: { name: true } } } });
        for (const s of staff) if (isoOf(s.dateOfBirth!).slice(5) === md) items.push({ title: fullName(s), sub: s.designation?.name ?? 'Staff', badge: '🎂', tone: 'good' });
        return { items: items.slice(0, 12), empty: 'No birthdays today.', more: items.length > 12 ? { label: `+${items.length - 12} more`, href: '/students' } : undefined, note: showDay(todayIST(), { weekday: 'short', day: 'numeric', month: 'short' }) };
    },
});

// ─── Hostel ──────────────────────────────────────────────────────────────────

const hostelOptions = async (userId: string) => {
    const scope = await hostelScope(userId);
    const hostels = await db.hostel.findMany({ where: { isActive: true, ...(scope === 'all' ? {} : { id: { in: scope } }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { hostels, options: [{ value: '', label: 'All hostels' }, ...hostels.map((h) => ({ value: h.id, label: h.name }))] };
};

defineWidget({
    key: 'hostel_out',
    label: 'Boarders out',
    description: 'Boarders out of the hostel on leave now, overdue ones first.',
    category: 'Today',
    type: 'list',
    size: 'sm',
    href: '/hostel/leave',
    permissions: ['hostel.warden', 'hostel.view', 'hostel.gate'],
    cacheSeconds: 120,
    async load({ userId, filter }) {
        const { hostels, options } = await hostelOptions(userId);
        if (!hostels.length) return { hidden: true, items: [], empty: '' };
        const ids = filter && hostels.some((h) => h.id === filter) ? [filter] : hostels.map((h) => h.id);
        const out = await db.hostelLeave.findMany({ where: { status: 'out', hostelId: { in: ids } }, orderBy: { toAt: 'asc' } });
        const st = await db.student.findMany({ where: { id: { in: out.map((o) => o.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
        const now = Date.now();
        return {
            items: out.slice(0, 8).map((o) => {
                const late = o.toAt.getTime() < now;
                return { title: fullName(st.find((s) => s.id === o.studentId) ?? { firstName: '' }), sub: `${hostels.find((h) => h.id === o.hostelId)?.name ?? ''} · ${o.reason}`, meta: late ? 'overdue' : `back ${o.toAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`, tone: late ? ('bad' as const) : ('neutral' as const) };
            }),
            empty: 'Every boarder is in.',
            more: out.length > 8 ? { label: `+${out.length - 8} more`, href: '/hostel/leave' } : undefined,
            filter: hostels.length > 1 ? { value: filter && ids.length === 1 ? filter : '', options } : undefined,
        };
    },
});

defineWidget({
    key: 'hostel_occupancy',
    label: 'Hostel beds',
    description: 'Beds taken in each hostel, and the empty ones.',
    category: 'School',
    type: 'donut',
    size: 'sm',
    href: '/hostel',
    permissions: ['hostel.view', 'hostel.allot', 'hostel.setup', 'hostel.warden'],
    cacheSeconds: 600,
    async load({ userId }) {
        const { hostels } = await hostelOptions(userId);
        if (!hostels.length) return { hidden: true, slices: [] };
        const [beds, used] = await Promise.all([db.hostelRoom.aggregate({ where: { isActive: true, hostelId: { in: hostels.map((h) => h.id) } }, _sum: { beds: true } }), db.hostelAllotment.groupBy({ by: ['hostelId'], where: { status: 'active', hostelId: { in: hostels.map((h) => h.id) } }, _count: { _all: true } })]);
        const taken = used.reduce((a, u) => a + u._count._all, 0);
        return { slices: [...hostels.map((h) => ({ label: h.name, value: used.find((u) => u.hostelId === h.id)?._count._all ?? 0 })), { label: 'Empty beds', value: Math.max(0, (beds._sum.beds ?? 0) - taken) }], centerLabel: `${taken} / ${beds._sum.beds ?? 0} beds` };
    },
});

// ─── Mess ────────────────────────────────────────────────────────────────────

defineWidget({
    key: 'mess_cost_trend',
    label: 'Kitchen cost per meal',
    description: 'What the store issued to the kitchen, divided by the meals served, each day.',
    category: 'School',
    type: 'chart',
    size: 'md',
    href: '/reports',
    permissions: ['mess.manage', 'mess.view'],
    cacheSeconds: 900,
    async load({ filter }) {
        const days = Number(period(filter));
        const t = todayIST();
        const from = addDays(t, -(days - 1));
        const [{ department, days: cost }, serves] = await Promise.all([kitchenCost(from, t), db.messServe.findMany({ where: { date: { gte: dayDate(from), lte: dayDate(t) } }, select: { date: true, subscriptionId: true, guests: true } })]);
        const meals = new Map<string, number>();
        for (const s of serves) meals.set(isoOf(s.date), (meals.get(isoOf(s.date)) ?? 0) + (s.subscriptionId ? 1 : s.guests));
        let totalCost = 0;
        let totalMeals = 0;
        const points = [];
        for (let i = 0; i < days; i++) {
            const d = addDays(from, i);
            const c = cost.get(d) ?? 0;
            const n = meals.get(d) ?? 0;
            totalCost += c;
            totalMeals += n;
            points.push({ label: showDay(d), value: n ? Math.round((c / n) * 10) / 10 : 0, hint: `${showDay(d, { weekday: 'short', day: 'numeric', month: 'short' })}: ${rupees(c)} for ${n} meals` });
        }
        return { kind: 'bar', points, money: true, caption: department ? `${rupees(totalCost)} for ${totalMeals} meals · ${totalMeals ? rupees(totalCost / totalMeals) : '—'} a meal` : 'Name the kitchen department in System Settings → Mess', filter: { value: String(days), options: PERIODS } };
    },
});

defineWidget({
    key: 'mess_ratings',
    label: 'Meal ratings',
    description: 'How members rated the meals in the last 7 days, and the lowest-rated meal.',
    category: 'School',
    type: 'stat',
    size: 'sm',
    href: '/mess',
    permissions: ['mess.manage', 'mess.view'],
    cacheSeconds: 900,
    async load() {
        const from = dayDate(addDays(todayIST(), -6));
        const [rows, ms] = await Promise.all([db.messRating.findMany({ where: { date: { gte: from } }, select: { date: true, mealId: true, stars: true } }), meals()]);
        if (!rows.length) return { value: '—', caption: 'no ratings in the last 7 days' };
        const avg = rows.reduce((a, r) => a + r.stars, 0) / rows.length;
        const by = new Map<string, number[]>();
        for (const r of rows) by.set(`${isoOf(r.date)}|${r.mealId}`, [...(by.get(`${isoOf(r.date)}|${r.mealId}`) ?? []), r.stars]);
        const worst = [...by.entries()].filter(([, v]) => v.length >= 3).map(([k, v]) => ({ k, avg: v.reduce((a, b) => a + b, 0) / v.length })).sort((a, b) => a.avg - b.avg)[0];
        const [wd, wm] = worst ? worst.k.split('|') : ['', ''];
        return {
            value: `${avg.toFixed(1)}★`,
            caption: `average of ${rows.length} ratings · last 7 days`,
            tone: avg >= 3.5 ? 'good' : avg >= 2.5 ? 'warn' : 'bad',
            sub: worst ? [{ label: 'Lowest', value: `${ms.find((m) => m.id === wm)?.name ?? ''} ${showDay(wd)} (${worst.avg.toFixed(1)}★)`, tone: worst.avg < 2.5 ? ('bad' as const) : undefined }] : [],
        };
    },
});

// ─── Payroll and store ───────────────────────────────────────────────────────

defineWidget({
    key: 'payroll_trend',
    label: 'Salary bill',
    description: 'Gross and net salary of the last six months that were prepared.',
    category: 'School',
    type: 'chart',
    size: 'md',
    href: '/payroll',
    permissions: ['payroll.view', 'payroll.run', 'payroll.approve'],
    cacheSeconds: 1800,
    async load() {
        const runs = await db.payrollRun.findMany({ orderBy: { month: 'desc' }, take: 6, select: { month: true, status: true, slips: { select: { gross: true, net: true } } } });
        if (!runs.length) return { kind: 'bar', points: [], caption: 'No payroll prepared yet' };
        const points = runs.reverse().map((r) => {
            const gross = r.slips.reduce((a, s) => a + s.gross, 0);
            const net = r.slips.reduce((a, s) => a + s.net, 0);
            return { label: monthLabel(r.month), value: Math.round(net), hint: `${monthLabel(r.month)} (${r.status}): net ${rupees(net)} · gross ${rupees(gross)} · ${r.slips.length} staff` };
        });
        return { kind: 'bar', points, money: true, caption: `Net pay · latest ${rupees(points[points.length - 1].value)}` };
    },
});

defineWidget({
    key: 'inventory_value',
    label: 'Stock value',
    description: 'What the stock in every store is worth (at average cost), and items low in stock.',
    category: 'School',
    type: 'stat',
    size: 'sm',
    href: '/inventory',
    permissions: ['inventory.view', 'inventory.store', 'inventory.manage'],
    cacheSeconds: 900,
    async load() {
        const items = await db.invItem.findMany({ where: { isActive: true }, select: { avgCost: true, reorderLevel: true, stock: { select: { qty: true } } } });
        const value = items.reduce((a, i) => a + i.stock.reduce((b, s) => b + s.qty, 0) * i.avgCost, 0);
        const low = items.filter((i) => i.reorderLevel > 0 && i.stock.reduce((b, s) => b + s.qty, 0) <= i.reorderLevel).length;
        return { value: rupees(value), caption: `in stock · ${items.length} items`, tone: 'neutral', sub: [{ label: 'Low in stock', value: low, tone: low ? 'warn' : undefined }] };
    },
});

// ─── The person's own shortcuts ──────────────────────────────────────────────

defineWidget({
    key: 'quick_links',
    label: 'My shortcuts',
    description: 'The screens the person opens most, chosen by them (Customise → My shortcuts).',
    category: 'My day',
    type: 'list',
    size: 'sm',
    permissions: [],
    cacheSeconds: 5,
    async load({ userId }) {
        const d = await db.userDashboard.findFirst({ where: { userId }, select: { links: true } });
        const links = ((d?.links ?? []) as { label: string; href: string }[]).slice(0, 12);
        return { items: links.map((l) => ({ title: l.label, href: l.href })), empty: 'No shortcuts yet: choose Customise, then “My shortcuts”.' };
    },
});

// ─── What each role's built-in dashboard adds ────────────────────────────────

// "Waiting for me" is now the action centre at the top of the page (it can still be added as a widget).
dropFromDefaultLayouts('approvals');

for (const r of ['school-admin', 'super-admin']) extendDefaultLayout(r, ['fee_monthly', 'attendance_trend', 'birthdays_today', 'hostel_occupancy', 'mess_today', 'payroll_trend', 'inventory_value']);
extendDefaultLayout('principal', ['attendance_trend', 'fee_monthly', 'birthdays_today', 'hostel_occupancy', 'hostel_out', 'mess_today', 'mess_ratings', 'payroll_trend']);
extendDefaultLayout('office-staff', ['birthdays_today', 'hostel_out', 'quick_links']);
extendDefaultLayout('accountant', ['fee_monthly', 'payroll_trend', 'inventory_value', 'quick_links']);
for (const r of ['teacher', 'class-teacher']) extendDefaultLayout(r, ['birthdays_today', 'quick_links']);
extendDefaultLayout('warden', ['hostel_out', 'hostel_occupancy', 'birthdays_today'], 'hostel_status');
extendDefaultLayout('mess-incharge', ['mess_cost_trend', 'mess_ratings'], 'mess_today');
extendDefaultLayout('storekeeper', ['inventory_value'], 'inventory_status');
extendDefaultLayout('librarian', ['birthdays_today']);
extendDefaultLayout('security-guard', ['hostel_out'], 'visitors_now');
for (const r of ['student', 'guardian']) extendDefaultLayout(r, ['quick_links']);
defineDefaultLayout('driver', ['my_checkin', 'my_leave', 'notices_latest', 'upcoming_events', 'quick_links']);
