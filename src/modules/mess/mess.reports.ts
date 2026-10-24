import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDefaultLayout, defineWidget } from '../dashboard/dashboard.registry';
import { kitchenCost, listMembers, meals, today } from './mess.service';

/** Mess reports (Report Center) and a dashboard widget. */

registerReportCategory('Mess', 63);

const VIEW = ['mess.view', 'mess.manage'];
const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lte: dayDate(f.to) };
};
const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let t = dayDate(from).getTime(); t <= dayDate(to).getTime() && out.length < 400; t += 86_400_000) out.push(isoOf(new Date(t)));
    return out;
};

defineReport({
    key: 'mess_members',
    category: 'Mess',
    label: 'Mess members',
    description: 'Everyone on a mess plan, grouped by plan.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: [{ key: 'kind', label: 'Who', type: 'select', default: '', options: [{ value: '', label: 'Everyone' }, { value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }] }],
    columns: [
        { key: 'name', label: 'Name', type: 'text', width: 1.6 },
        { key: 'code', label: 'Adm. no. / code', type: 'text', width: 0.9 },
        { key: 'sub', label: 'Class / designation', type: 'text', width: 1 },
        { key: 'from', label: 'Since', type: 'date', width: 0.7 },
        { key: 'source', label: 'Added', type: 'text', width: 0.7 },
    ],
    async run(f) {
        const rows = await listMembers({ show: 'active', kind: (f.kind || '') as '' | 'student' | 'staff' });
        return { subtitle: `${rows.length} members`, groupedBy: 'Plan', rows: rows.map((r) => ({ groupKey: r.plan, groupLabel: r.plan, name: r.name, code: r.code, sub: r.sub, from: r.from, source: r.source === 'hostel' ? 'With the hostel' : 'By the office' })).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.name.localeCompare(b.name)) };
    },
});

defineReport({
    key: 'mess_daily',
    category: 'Mess',
    label: 'Meals served by day',
    description: 'For each day and meal: members served and guests.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.8 },
        { key: 'meal', label: 'Meal', type: 'text', width: 1 },
        { key: 'served', label: 'Members served', type: 'number', width: 0.8, total: true },
        { key: 'skipped', label: 'Skipped', type: 'number', width: 0.6, total: true },
        { key: 'guests', label: 'Guests', type: 'number', width: 0.6, total: true },
        { key: 'amount', label: 'Guest charges', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const [ms, serves, skips] = await Promise.all([meals(), db.messServe.findMany({ where: { date: between(f) }, select: { date: true, mealId: true, subscriptionId: true, guests: true, amount: true } }), db.messSkip.groupBy({ by: ['date', 'mealId'], where: { date: between(f) }, _count: { _all: true } })]);
        const rows = [];
        for (const d of days(f.from, f.to))
            for (const m of ms) {
                const s = serves.filter((x) => isoOf(x.date) === d && x.mealId === m.id);
                const skipped = skips.find((x) => isoOf(x.date) === d && x.mealId === m.id)?._count._all ?? 0;
                if (!s.length && !skipped) continue;
                rows.push({ date: d, meal: m.name, served: s.filter((x) => x.subscriptionId).length, skipped, guests: s.reduce((a, x) => a + x.guests, 0), amount: s.reduce((a, x) => a + x.amount, 0) });
            }
        return { subtitle: `${f.from} – ${f.to}`, rows };
    },
});

defineReport({
    key: 'mess_guests',
    category: 'Mess',
    label: 'Guest meals',
    description: 'Guests served and who pays (cash, a student’s fees or a staff member’s salary).',
    permissions: VIEW,
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'meal', label: 'Meal', type: 'text', width: 0.8 },
        { key: 'guest', label: 'Guest', type: 'text', width: 1.4 },
        { key: 'guests', label: 'No.', type: 'number', width: 0.4, total: true },
        { key: 'payBy', label: 'Paid by', type: 'text', width: 1.4 },
        { key: 'amount', label: 'Amount', type: 'money', width: 0.7, total: true },
    ],
    async run(f) {
        const rows = await db.messServe.findMany({ where: { date: between(f), subscriptionId: null }, orderBy: { at: 'asc' } });
        const [ms, st, sf] = await Promise.all([meals(), db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, lastName: true, admissionNo: true } }), db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, lastName: true } })]);
        const payer = (r: (typeof rows)[number]) => {
            if (r.payBy === 'student') { const s = st.find((x) => x.id === r.studentId); return `Fees of ${s ? `${s.firstName} ${s.lastName ?? ''} (${s.admissionNo})` : ''}`; }
            if (r.payBy === 'staff') { const s = sf.find((x) => x.id === r.staffId); return `Salary of ${s ? `${s.firstName} ${s.lastName ?? ''}` : ''}`; }
            return r.payBy === 'free' ? 'Free (school guest)' : 'Cash';
        };
        return { subtitle: `${f.from} – ${f.to}`, rows: rows.map((r) => ({ date: isoOf(r.date), meal: ms.find((m) => m.id === r.mealId)?.name ?? '', guest: r.guestName ?? '', guests: r.guests, payBy: payer(r), amount: r.amount })) };
    },
});

defineReport({
    key: 'mess_cost',
    category: 'Mess',
    label: 'Kitchen cost per meal',
    description: 'What the store issued to the kitchen each day, the meals served, and the cost per meal.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.8 },
        { key: 'cost', label: 'Kitchen cost', type: 'money', width: 0.9, total: true },
        { key: 'meals', label: 'Meals served', type: 'number', width: 0.8, total: true },
        { key: 'perMeal', label: 'Cost per meal', type: 'money', width: 0.8 },
    ],
    async run(f) {
        between(f);
        const [{ department, days: cost }, serves] = await Promise.all([kitchenCost(f.from, f.to), db.messServe.findMany({ where: { date: between(f) }, select: { date: true, subscriptionId: true, guests: true } })]);
        const rows = days(f.from, f.to).map((d) => {
            // A member row is one meal; a guest row counts its guests.
            const n = serves.filter((x) => isoOf(x.date) === d).reduce((a, x) => a + (x.subscriptionId ? 1 : x.guests), 0);
            const c = Math.round((cost.get(d) ?? 0) * 100) / 100;
            return { date: d, cost: c, meals: n, perMeal: n ? Math.round((c / n) * 100) / 100 : 0 };
        }).filter((r) => r.cost || r.meals);
        return { subtitle: department ? `${f.from} – ${f.to} · issues to ${department}` : `No department named as in System Settings → Mess`, rows };
    },
});

defineReport({
    key: 'mess_ratings',
    category: 'Mess',
    label: 'Meal ratings',
    description: 'Average rating of each meal by day, with comments.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'meal', label: 'Meal', type: 'text', width: 0.9 },
        { key: 'items', label: 'Ratings', type: 'number', width: 0.5 },
        { key: 'avg', label: 'Average ★', type: 'number', width: 0.6 },
        { key: 'comments', label: 'Comments', type: 'text', width: 2.4 },
    ],
    async run(f) {
        const [ms, rows] = await Promise.all([meals(), db.messRating.findMany({ where: { date: between(f) }, orderBy: { date: 'asc' } })]);
        const keys = [...new Set(rows.map((r) => `${isoOf(r.date)}|${r.mealId}`))];
        return {
            subtitle: `${f.from} – ${f.to}`,
            rows: keys.map((k) => {
                const [d, mealId] = k.split('|');
                const rs = rows.filter((r) => isoOf(r.date) === d && r.mealId === mealId);
                return { date: d, meal: ms.find((m) => m.id === mealId)?.name ?? '', items: rs.length, avg: Math.round((rs.reduce((a, r) => a + r.stars, 0) / rs.length) * 10) / 10, comments: rs.map((r) => r.comment).filter(Boolean).join(' · ') };
            }),
        };
    },
});

defineWidget({
    key: 'mess_today',
    label: 'Mess today',
    description: 'How many to cook for at each meal today and how many have eaten.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/mess',
    permissions: ['mess.manage', 'mess.view', 'mess.counter'],
    cacheSeconds: 300,
    async load() {
        const t = await today(todayIST());
        const next = t.meals.find((m) => !m.started) ?? t.meals[t.meals.length - 1];
        return { value: next?.cook ?? 0, caption: next ? `for ${next.name}` : 'no meals set up', tone: 'neutral', sub: t.meals.map((m) => ({ label: m.name, value: m.started ? `${m.served + m.guests} eaten / ${m.cook}` : `${m.cook} to cook` })) };
    },
});

defineDefaultLayout('mess-incharge', ['mess_today', 'inventory_status', 'my_checkin', 'approvals', 'my_leave', 'notices_latest', 'upcoming_events']);
