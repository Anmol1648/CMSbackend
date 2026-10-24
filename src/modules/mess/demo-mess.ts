import { db, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { demoStaffWithLogin } from '../hostel/demo-hostel';
import { getSettings } from '../../core/settings';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { INVENTORY } from '../inventory/inventory.settings';
import { applyMove, nextNumber } from '../inventory/inventory.service';
import { expected, meals, saveMenu, savePlan, saveSpecial, subscribe, syncBoarders } from './mess.service';

/**
 * Demo mess: four plans (boarders' full board taking every boarder, day scholars' lunch, two staff
 * plans), a two-week menu and a special Diwali dinner, ~15 day scholars and ~8 staff (Deepak
 * Rautela among them), a week of meals served at the counter, skipped meals, guests (cash, on a
 * student's fees, on a staff salary), ratings, kitchen supplies issued from the store to the
 * Kitchen (the kitchen cost), and a Mess In-charge with a login. Marked is_demo.
 * Run after the hostel demo (boarders).
 */

let seed = 8_383;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;

// Week 1 and week 2: [breakfast, lunch, snacks, dinner] for Monday … Sunday.
const MENU: string[][][] = [
    [
        ['Aloo paratha, curd, tea', 'Rajma, rice, roti, salad', 'Samosa, tea', 'Mix veg, dal tadka, roti, rice, kheer'],
        ['Poha, banana, milk', 'Kadhi pakora, rice, roti', 'Biscuits, tea', 'Paneer butter masala, roti, rice'],
        ['Idli, sambar, chutney', 'Chole, rice, roti, salad', 'Sprouts chaat', 'Aloo gobhi, dal, roti, rice'],
        ['Bread, butter, jam, milk', 'Dal makhani, jeera rice, roti', 'Pakora, tea', 'Egg curry / matar paneer, roti, rice'],
        ['Upma, boiled egg, tea', 'Mixed dal, aloo jeera, rice, roti', 'Fruit', 'Bhindi, dal, roti, rice, halwa'],
        ['Puri, aloo sabzi, tea', 'Veg pulao, raita, papad', 'Bhel puri', 'Kadai paneer, dal, roti, rice'],
        ['Chole bhature, lassi', 'Veg biryani, raita, salad', 'Cake, tea', 'Chicken curry / shahi paneer, roti, rice, gulab jamun'],
    ],
    [
        ['Gobhi paratha, curd, tea', 'Lobia, rice, roti, salad', 'Bread pakora, tea', 'Lauki chana dal, roti, rice'],
        ['Vermicelli upma, milk', 'Black chana, rice, roti', 'Murmura, tea', 'Malai kofta, roti, rice'],
        ['Dosa, sambar, chutney', 'Rajma, rice, roti', 'Corn chaat', 'Aloo matar, dal, roti, rice'],
        ['Cornflakes, milk, banana', 'Arhar dal, aloo bhujia, rice, roti', 'Biscuits, tea', 'Soya chunks curry, roti, rice'],
        ['Besan chilla, tea', 'Kadhi, rice, roti', 'Fruit', 'Mix veg, dal, roti, rice, sewaiyan'],
        ['Puri, chana, tea', 'Khichdi, curd, papad, pickle', 'Pav bhaji', 'Paneer bhurji, dal, roti, rice'],
        ['Stuffed paratha, butter, tea', 'Veg fried rice, manchurian', 'Jalebi', 'Mutton curry / paneer tikka masala, roti, rice, rasgulla'],
    ],
];

// name, unit, rate, weekly use
const KITCHEN: [string, string, number, number][] = [
    ['Rice (Basmati)', 'Kg', 78, 70],
    ['Wheat flour (atta)', 'Kg', 36, 90],
    ['Arhar dal', 'Kg', 140, 18],
    ['Rajma', 'Kg', 150, 8],
    ['Mustard oil', 'Litre', 165, 16],
    ['Milk', 'Litre', 56, 140],
    ['Vegetables (mixed)', 'Kg', 40, 120],
    ['Paneer', 'Kg', 340, 10],
    ['Sugar', 'Kg', 44, 14],
    ['Tea leaves', 'Kg', 420, 1.5],
];

export const createDemoMess = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.messPlan.count({ where: { isDemo: true } }))) return { plans: 0, members: 0, served: 0, incharge: null as string | null };
    await seedMasters();
    const need = [
        ['notification_type', 'Mess', 'mess', { icon: 'restaurant' }],
        ['fee_head', 'Mess fee', 'MESS', { one_time: false, refundable: false }],
    ] as const;
    for (const [master, name, c, extra] of need) if (!(await db.masterValue.findFirst({ where: { master, code: c } }))) await db.masterValue.create({ data: { tenantId, master, name, code: c, sortOrder: 99, extra } });
    for (const [master, name] of [['department', 'Kitchen'], ['inv_category', 'Kitchen provisions'], ['inv_unit', 'Kg'], ['inv_unit', 'Litre']] as const)
        if (!(await db.masterValue.findFirst({ where: { master, name: { equals: name, mode: 'insensitive' } } }))) await db.masterValue.create({ data: { tenantId, master, name, sortOrder: 90, extra: {} } });
    const mv = await db.masterValue.findMany({ where: { master: { in: ['department', 'inv_category', 'inv_unit', 'inv_store'] } }, select: { id: true, name: true, master: true } });
    const mid = (master: string, name: string) => mv.find((x) => x.master === master && x.name.toLowerCase().startsWith(name.toLowerCase()))?.id ?? null;

    // The Mess In-charge: a demo staff member without a login gets one.
    let role = await db.role.findFirst({ where: { slug: 'mess-incharge' } });
    role ??= await db.role.create({ data: { tenantId, slug: 'mess-incharge', name: 'Mess In-charge', description: 'Runs the mess: menu, daily headcount, the counter, guests and kitchen costs.' } });
    const ic = await demoStaffWithLogin(role, { firstName: 'Ramesh', lastName: 'Bisht', female: false, department: 'Kitchen', designation: 'Sub Staff' });
    const incharge: string | null = ic.username;
    let by: string | null = ic.userId;
    by ??= (await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } }))?.id ?? null;

    // Plans and the menu.
    const ms = await meals();
    const meal = (n: string) => ms.find((m) => m.name.startsWith(n))!;
    const all = ms.map((m) => m.id);
    const board = await savePlan(null, { name: 'Boarders – full board', mealIds: all, fee: 12000, monthly: 0, forBoarders: true, forWho: 'students', isActive: true }, { isDemo: true });
    const lunch = await savePlan(null, { name: 'Day scholars – lunch', mealIds: [meal('Lunch').id], fee: 3500, monthly: 0, forBoarders: false, forWho: 'students', isActive: true }, { isDemo: true });
    const staffLunch = await savePlan(null, { name: 'Staff – lunch and tea', mealIds: [meal('Lunch').id, meal('Evening').id], fee: 0, monthly: 1400, forBoarders: false, forWho: 'staff', isActive: true }, { isDemo: true });
    const staffFull = await savePlan(null, { name: 'Staff – full board (resident)', mealIds: all, fee: 0, monthly: 3800, forBoarders: false, forWho: 'staff', isActive: true }, { isDemo: true });
    const order = ['Breakfast', 'Lunch', 'Evening', 'Dinner'];
    await saveMenu({ rows: MENU.flatMap((w, wi) => w.flatMap((d, di) => d.map((items, mi) => ({ week: wi + 1, weekday: di + 1, mealId: meal(order[mi]).id, items })))) }, { isDemo: true });
    const today = todayIST();
    const isoIn = (d: number) => isoOf(new Date(dayDate(today).getTime() + d * DAY));
    const diwali = '2026-11-08' > today ? '2026-11-08' : isoIn(4);
    await saveSpecial({ date: diwali, mealId: meal('Dinner').id, items: 'Diwali dinner: paneer tikka, dal makhani, naan, pulao, kaju katli, gulab jamun', note: 'Diwali' }, { isDemo: true });

    // Members: every boarder (hostel), day scholars on lunch, staff.
    await syncBoarders({ isDemo: true });
    const boarders = new Set((await db.messSubscription.findMany({ where: { planId: board.id }, select: { studentId: true } })).map((s) => s.studentId));
    const enrolled = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', isDemo: true } }, select: { studentId: true }, orderBy: { studentId: 'desc' }, take: 300 });
    const dayScholars = enrolled.map((e) => e.studentId).filter((id) => !boarders.has(id)).filter(() => rand() < 0.08).slice(0, 15);
    const from = isoOf(year.startDate);
    if (dayScholars.length) await subscribe({ planId: lunch.id, studentIds: dayScholars, staffIds: [], fromDate: from }, null, { isDemo: true });
    const deepak = await db.staff.findFirst({ where: { firstName: 'Deepak', lastName: 'Rautela' }, select: { id: true } });
    const staff = (await db.staff.findMany({ where: { isDemo: true, status: 'working', id: { not: deepak?.id } }, orderBy: { employeeCode: 'asc' }, select: { id: true }, take: 40 })).filter(() => rand() < 0.2).slice(0, 6).map((s) => s.id);
    await subscribe({ planId: staffLunch.id, studentIds: [], staffIds: [...(deepak ? [deepak.id] : []), ...staff.slice(0, 4)], fromDate: isoOf(new Date(dayDate(today).getTime() - 75 * DAY)) }, null, { isDemo: true });
    if (staff.length > 4) await subscribe({ planId: staffFull.id, studentIds: [], staffIds: staff.slice(4), fromDate: isoOf(new Date(dayDate(today).getTime() - 75 * DAY)) }, null, { isDemo: true });
    await db.messSubscription.updateMany({ where: { planId: { in: [board.id, lunch.id, staffLunch.id, staffFull.id] } }, data: { isDemo: true } });

    // Skipped meals: a few members skip upcoming meals; some skipped last week.
    const subs = await db.messSubscription.findMany({ where: { status: 'active' }, select: { id: true, studentId: true, staffId: true, planId: true } });
    const sample = await db.student.findFirst({ where: { admissionNo: '2025/0235' }, select: { id: true } });
    const skipRows: { subscriptionId: string; date: string; mealId: string }[] = [];
    for (const s of subs) {
        const mealIds = s.planId === board.id ? all : s.planId === staffFull.id ? all : s.planId === lunch.id ? [meal('Lunch').id] : [meal('Lunch').id, meal('Evening').id];
        for (let d = -7; d <= 3; d++) if (rand() < 0.06) skipRows.push({ subscriptionId: s.id, date: isoIn(d), mealId: mealIds[Math.floor(rand() * mealIds.length)] });
        if (sample && s.studentId === sample.id) skipRows.push({ subscriptionId: s.id, date: isoIn(1), mealId: meal('Breakfast').id });
    }
    const seen = new Set<string>();
    await db.messSkip.createMany({ data: skipRows.filter((r) => { const k = `${r.subscriptionId}|${r.date}|${r.mealId}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((r) => ({ tenantId, subscriptionId: r.subscriptionId, date: dayDate(r.date), mealId: r.mealId, createdBy: by, isDemo: true })) });

    // A week of meals at the counter (most of those expected came), and today's meals already over.
    let served = 0;
    const now = Date.now();
    for (let d = -7; d <= 0; d++) {
        const date = isoIn(d);
        for (const m of ms) {
            const start = new Date(`${date}T${m.time}:00+05:30`);
            if (start.getTime() > now) continue;
            const e = await expected(date, m);
            const rows = e.subs.filter((s) => !e.skipped.has(s.id) && !(s.studentId && e.away.has(s.studentId)) && rand() < 0.93).map((s) => ({ tenantId, date: dayDate(date), mealId: m.id, subscriptionId: s.id, at: new Date(start.getTime() + Math.floor(rand() * 50) * 60_000), by, isDemo: true }));
            if (rows.length) await db.messServe.createMany({ data: rows });
            served += rows.length;
        }
    }
    const lunchId = meal('Lunch').id;
    const deepakSub = subs.find((s) => s.staffId === deepak?.id);
    const guests = [
        { d: -6, mealId: lunchId, guestName: 'CBSE inspection team', guests: 3, payBy: 'free', studentId: null, staffId: null },
        { d: -4, mealId: meal('Dinner').id, guestName: 'Parent of Shubham Nautiyal', guests: 2, payBy: 'student', studentId: sample?.id ?? null, staffId: null },
        { d: -3, mealId: lunchId, guestName: 'Guest of Deepak Rautela', guests: 1, payBy: deepakSub ? 'staff' : 'cash', studentId: null, staffId: deepakSub ? deepak!.id : null },
        { d: -1, mealId: lunchId, guestName: 'Visiting coach (football)', guests: 1, payBy: 'cash', studentId: null, staffId: null },
    ];
    for (const g of guests) {
        if (g.payBy === 'student' && !g.studentId) continue;
        const m = ms.find((x) => x.id === g.mealId)!;
        const date = isoIn(g.d);
        await db.messServe.create({ data: { tenantId, date: dayDate(date), mealId: m.id, guestName: g.guestName, guests: g.guests, amount: g.payBy === 'free' ? 0 : m.rate * g.guests, payBy: g.payBy, studentId: g.studentId, staffId: g.staffId, at: new Date(`${date}T${m.time}:00+05:30`), by, isDemo: true } });
    }

    // Ratings from members with logins over the last three days.
    const raters = await db.messSubscription.findMany({ where: { status: 'active' }, select: { studentId: true, staffId: true } });
    const [su, fu] = await Promise.all([db.student.findMany({ where: { id: { in: raters.map((r) => r.studentId!).filter(Boolean) }, userId: { not: null } }, select: { userId: true }, take: 25 }), db.staff.findMany({ where: { id: { in: raters.map((r) => r.staffId!).filter(Boolean) }, userId: { not: null } }, select: { userId: true } })]);
    const users = [...su.map((s) => s.userId!), ...fu.map((s) => s.userId!)];
    const COMMENTS = ['Very tasty', 'Roti was cold', 'Good', 'Too much oil', 'Loved the kheer', 'Rice undercooked', ''];
    const ratings = [];
    for (let d = -3; d <= -1; d++)
        for (const m of ms)
            for (const u of users)
                if (rand() < 0.4) {
                    const stars = Math.min(5, Math.max(1, Math.round(3.8 + (rand() - 0.5) * 3)));
                    ratings.push({ tenantId, date: dayDate(isoIn(d)), mealId: m.id, userId: u, stars, comment: rand() < 0.3 ? COMMENTS[Math.floor(rand() * COMMENTS.length)] || null : null, isDemo: true });
                }
    if (ratings.length) await db.messRating.createMany({ data: ratings, skipDuplicates: true });

    // Kitchen supplies: bought into the main store and issued to the Kitchen twice a week (the kitchen cost).
    const store = mid('inv_store', 'Main store') ?? (await db.masterValue.findFirst({ where: { master: 'inv_store' }, select: { id: true } }))?.id ?? null;
    const kitchen = mid('department', 'Kitchen');
    if (store && kitchen) {
        const tx = db as unknown as Tx;
        const { prefix } = await getSettings({ prefix: INVENTORY.itemPrefix });
        for (const [name, unit, rate, weekly] of KITCHEN) {
            const it = await db.invItem.create({ data: { tenantId, code: await nextNumber('inv_item', prefix), name, categoryId: mid('inv_category', 'Kitchen'), unitId: mid('inv_unit', unit), reorderLevel: Math.ceil(weekly / 2), reorderQty: Math.ceil(weekly * 2), isDemo: true } });
            await applyMove(tx, { itemId: it.id, storeId: store, kind: 'opening', qty: Math.ceil(weekly * 6), rate, refType: 'opening', note: 'Opening stock', userId: by, at: new Date(now - 30 * DAY), isDemo: true }, true);
            for (let d = 28; d >= 1; d -= 3.5) {
                const qty = Math.round(weekly * 0.5 * (0.85 + rand() * 0.3) * 10) / 10;
                await applyMove(tx, { itemId: it.id, storeId: store, kind: 'issue', qty: -qty, departmentId: kitchen, refType: 'issue', refNo: await nextNumber('inv_issue', 'ISS-'), note: 'To the mess kitchen', userId: by, at: new Date(now - d * DAY), isDemo: true }, true);
            }
        }
    }

    const members = await db.messSubscription.count({ where: { status: 'active' } });
    return { plans: 4, members, served, incharge };
};

export const clearDemoMess = async () => {
    await db.messRating.deleteMany({ where: { isDemo: true } });
    await db.messServe.deleteMany({ where: { isDemo: true } });
    await db.messSkip.deleteMany({ where: { isDemo: true } });
    await db.messSpecial.deleteMany({ where: { isDemo: true } });
    await db.messMenu.deleteMany({ where: { isDemo: true } });
    await db.messSubscription.deleteMany({ where: { isDemo: true } });
    await db.messPlan.deleteMany({ where: { isDemo: true } });
};
