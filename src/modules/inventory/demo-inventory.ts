import { db, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { hashPassword } from '../../core/password';
import { getSettings } from '../../core/settings';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { INVENTORY } from './inventory.settings';
import { applyMove, nextNumber } from './inventory.service';
import { receive } from './purchase.service';
import { sell } from './sales.service';

/**
 * Demo inventory: ~80 items in three stores with opening stock, lab chemicals and first-aid in
 * batches (some expiring soon), two purchase orders (one received, one half received) and one
 * waiting for approval, two months of issues to departments, staff requests (one for Deepak
 * Rautela to issue, one waiting for approval), a write-off to approve, uniform and diary sales
 * (Shubham Nautiyal's into his fees), and a storekeeper with a login. Marked is_demo.
 */

let seed = 6_262;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: T[]) => l[Math.floor(rand() * l.length)];
const DAY = 86_400_000;
const PASSWORD = 'Demo@2026';

// name, category, unit, reorder level, opening qty, rate, store, extra
type Row = [string, string, string, number, number, number, string, { sell?: number; expiry?: number; gst?: number }?];
const ITEMS: Row[] = [
    ['A4 paper (75 gsm)', 'Stationery', 'Ream', 20, 14, 290, 'Main store', { gst: 12 }],
    ['Legal paper', 'Stationery', 'Ream', 5, 8, 340, 'Main store', { gst: 12 }],
    ['Chart paper (assorted)', 'Stationery', 'Piece', 100, 260, 8, 'Main store'],
    ['Whiteboard marker (black)', 'Stationery', 'Box', 10, 6, 220, 'Main store', { gst: 18 }],
    ['Whiteboard marker (blue)', 'Stationery', 'Box', 10, 12, 220, 'Main store', { gst: 18 }],
    ['Permanent marker', 'Stationery', 'Box', 4, 7, 180, 'Main store', { gst: 18 }],
    ['Chalk (white, dustless)', 'Stationery', 'Box', 30, 85, 45, 'Main store'],
    ['Chalk (coloured)', 'Stationery', 'Box', 10, 24, 60, 'Main store'],
    ['Duster', 'Stationery', 'Piece', 15, 40, 35, 'Main store'],
    ['Ball pen (blue)', 'Stationery', 'Box', 10, 22, 100, 'Main store', { gst: 18 }],
    ['Ball pen (red)', 'Stationery', 'Box', 5, 9, 100, 'Main store', { gst: 18 }],
    ['Pencil (HB)', 'Stationery', 'Box', 10, 18, 50, 'Main store'],
    ['Eraser', 'Stationery', 'Box', 5, 10, 60, 'Main store'],
    ['Stapler', 'Stationery', 'Piece', 5, 12, 120, 'Main store', { gst: 18 }],
    ['Staple pins (No. 10)', 'Stationery', 'Box', 20, 15, 12, 'Main store'],
    ['File folder', 'Stationery', 'Piece', 50, 180, 15, 'Main store'],
    ['Register (200 pages)', 'Stationery', 'Piece', 20, 45, 85, 'Main store'],
    ['Attendance register', 'Stationery', 'Piece', 10, 30, 110, 'Main store'],
    ['Envelope (A4)', 'Stationery', 'Packet', 10, 25, 90, 'Main store'],
    ['Glue stick', 'Stationery', 'Piece', 30, 70, 20, 'Main store'],
    ['Cello tape', 'Stationery', 'Roll', 20, 48, 25, 'Main store'],
    ['Answer sheet (exam)', 'Stationery', 'Packet', 40, 120, 160, 'Main store'],
    ['Phenyl', 'Cleaning & housekeeping', 'Litre', 20, 45, 65, 'Main store'],
    ['Floor cleaner', 'Cleaning & housekeeping', 'Litre', 15, 10, 120, 'Main store', { gst: 18 }],
    ['Toilet cleaner', 'Cleaning & housekeeping', 'Bottle', 20, 36, 95, 'Main store', { gst: 18 }],
    ['Hand wash', 'Cleaning & housekeeping', 'Litre', 15, 22, 140, 'Main store', { gst: 18 }],
    ['Broom', 'Cleaning & housekeeping', 'Piece', 10, 24, 80, 'Main store'],
    ['Mop', 'Cleaning & housekeeping', 'Piece', 6, 12, 180, 'Main store'],
    ['Garbage bags (large)', 'Cleaning & housekeeping', 'Packet', 15, 9, 110, 'Main store'],
    ['Toilet roll', 'Cleaning & housekeeping', 'Roll', 50, 140, 22, 'Main store'],
    ['Toner (HP 88A)', 'Printing & toner', 'Piece', 3, 2, 2400, 'Main store', { gst: 18 }],
    ['Toner (Canon 2425)', 'Printing & toner', 'Piece', 2, 3, 3200, 'Main store', { gst: 18 }],
    ['Ink bottle (Epson, black)', 'Printing & toner', 'Bottle', 4, 6, 450, 'Main store', { gst: 18 }],
    ['Tube light (LED, 20W)', 'Electrical', 'Piece', 10, 18, 240, 'Main store', { gst: 18 }],
    ['LED bulb (9W)', 'Electrical', 'Piece', 15, 30, 95, 'Main store', { gst: 18 }],
    ['Extension board', 'Electrical', 'Piece', 4, 6, 380, 'Main store', { gst: 18 }],
    ['AA battery', 'Electrical', 'Packet', 10, 14, 120, 'Main store', { gst: 18 }],
    ['Switch (6A)', 'Electrical', 'Piece', 20, 40, 45, 'Main store', { gst: 18 }],
    ['Shirt (white, school)', 'Uniform', 'Piece', 40, 160, 260, 'Main store', { sell: 350, gst: 5 }],
    ['Trousers (grey)', 'Uniform', 'Piece', 30, 120, 340, 'Main store', { sell: 450, gst: 5 }],
    ['Skirt (grey)', 'Uniform', 'Piece', 20, 70, 300, 'Main store', { sell: 400, gst: 5 }],
    ['Tie (school)', 'Uniform', 'Piece', 40, 150, 60, 'Main store', { sell: 90, gst: 5 }],
    ['Belt (school)', 'Uniform', 'Piece', 30, 110, 75, 'Main store', { sell: 110, gst: 5 }],
    ['Sweater (navy)', 'Uniform', 'Piece', 30, 90, 520, 'Main store', { sell: 700, gst: 5 }],
    ['House T-shirt', 'Uniform', 'Piece', 40, 140, 180, 'Main store', { sell: 250, gst: 5 }],
    ['School diary 2026-27', 'Books & diaries', 'Piece', 50, 320, 70, 'Main store', { sell: 120 }],
    ['Notebook (ruled, 200 pages)', 'Books & diaries', 'Piece', 100, 600, 32, 'Main store', { sell: 50 }],
    ['Notebook (practical)', 'Books & diaries', 'Piece', 50, 240, 45, 'Main store', { sell: 70 }],
    ['ID card holder and lanyard', 'Books & diaries', 'Piece', 50, 400, 18, 'Main store', { sell: 30 }],
    ['Test tube (15 ml)', 'Lab consumables', 'Piece', 100, 340, 12, 'Science lab store'],
    ['Beaker (250 ml)', 'Lab consumables', 'Piece', 20, 46, 85, 'Science lab store', { gst: 18 }],
    ['Filter paper', 'Lab consumables', 'Packet', 10, 14, 120, 'Science lab store'],
    ['Litmus paper (red/blue)', 'Lab consumables', 'Packet', 10, 6, 60, 'Science lab store', { expiry: 400 }],
    ['Hydrochloric acid', 'Lab consumables', 'Bottle', 4, 6, 260, 'Science lab store', { expiry: 20 }],
    ['Sulphuric acid', 'Lab consumables', 'Bottle', 3, 4, 290, 'Science lab store', { expiry: 300 }],
    ['Sodium hydroxide', 'Lab consumables', 'Bottle', 3, 5, 210, 'Science lab store', { expiry: 45 }],
    ['Copper sulphate', 'Lab consumables', 'Bottle', 2, 3, 180, 'Science lab store', { expiry: 500 }],
    ['Phenolphthalein indicator', 'Lab consumables', 'Bottle', 2, 2, 150, 'Science lab store', { expiry: -5 }],
    ['Methylene blue stain', 'Lab consumables', 'Bottle', 2, 4, 170, 'Science lab store', { expiry: 200 }],
    ['Glass slide', 'Lab consumables', 'Box', 4, 9, 140, 'Science lab store'],
    ['Cover slip', 'Lab consumables', 'Box', 4, 7, 90, 'Science lab store'],
    ['Distilled water', 'Lab consumables', 'Litre', 20, 45, 25, 'Science lab store', { expiry: 600 }],
    ['Bunsen burner tube', 'Lab consumables', 'Metre', 5, 12, 60, 'Science lab store'],
    ['Football (size 5)', 'Sports', 'Piece', 4, 6, 850, 'Sports room', { gst: 12 }],
    ['Volleyball', 'Sports', 'Piece', 4, 5, 700, 'Sports room', { gst: 12 }],
    ['Basketball', 'Sports', 'Piece', 3, 2, 950, 'Sports room', { gst: 12 }],
    ['Cricket ball (leather)', 'Sports', 'Piece', 6, 10, 450, 'Sports room', { gst: 12 }],
    ['Shuttlecock (feather)', 'Sports', 'Box', 5, 4, 650, 'Sports room', { gst: 12 }],
    ['Table tennis ball', 'Sports', 'Box', 3, 6, 240, 'Sports room', { gst: 12 }],
    ['Skipping rope', 'Sports', 'Piece', 10, 25, 70, 'Sports room'],
    ['Whistle', 'Sports', 'Piece', 5, 12, 60, 'Sports room'],
    ['Cones (set of 10)', 'Sports', 'Set', 2, 4, 350, 'Sports room'],
    ['Antiseptic liquid', 'Medical (first aid)', 'Bottle', 4, 8, 180, 'Main store', { expiry: 25 }],
    ['Cotton roll', 'Medical (first aid)', 'Roll', 5, 12, 60, 'Main store', { expiry: 700 }],
    ['Bandage (crepe)', 'Medical (first aid)', 'Piece', 10, 20, 90, 'Main store', { expiry: 500 }],
    ['Band-aid strips', 'Medical (first aid)', 'Box', 5, 4, 120, 'Main store', { expiry: 15 }],
    ['ORS packet', 'Medical (first aid)', 'Packet', 30, 60, 22, 'Main store', { expiry: 90 }],
    ['Paracetamol syrup', 'Medical (first aid)', 'Bottle', 4, 6, 45, 'Main store', { expiry: 10 }],
    ['Burn ointment', 'Medical (first aid)', 'Piece', 3, 5, 95, 'Main store', { expiry: 220 }],
];
const VENDORS = [
    { name: 'Doon Stationers', extra: { phone: '9412000555', gstin: '05AAACD1234E1Z2' } },
    { name: 'Garhwal Scientific Traders', extra: { phone: '9412000666', gstin: '05AAACG5678F1Z9' } },
    { name: 'Himalaya Uniforms', extra: { phone: '9412000777', gstin: '' } },
    { name: 'Chamoli Medical Store', extra: { phone: '9412000888', gstin: '' } },
    { name: 'Joshimath Sports House', extra: { phone: '9412000999', gstin: '' } },
];

export const createDemoInventory = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.invItem.count({ where: { isDemo: true } }))) return { items: 0, moves: 0, storekeeper: null as string | null };
    await seedMasters();
    const tx = db as unknown as Tx;
    for (const [master, name, code, extra] of [['notification_type', 'Inventory', 'inventory', { icon: 'inventory' }], ['fee_head', 'Store (uniform, books)', 'STORE', { one_time: false, refundable: false }]] as const)
        if (!(await db.masterValue.findFirst({ where: { master, code } }))) await db.masterValue.create({ data: { tenantId, master, name, code, sortOrder: 99, extra } });
    for (const v of VENDORS) if (!(await db.masterValue.findFirst({ where: { master: 'asset_vendor', name: v.name } }))) await db.masterValue.create({ data: { tenantId, master: 'asset_vendor', name: v.name, sortOrder: 0, extra: v.extra } });
    const mv = await db.masterValue.findMany({ where: { master: { in: ['inv_category', 'inv_unit', 'inv_store', 'asset_vendor', 'department'] } }, select: { id: true, name: true, master: true } });
    const id = (master: string, name: string) => mv.find((m) => m.master === master && m.name.startsWith(name))?.id ?? null;

    // The storekeeper: a demo support staff member with a login and the Storekeeper role.
    let role = await db.role.findFirst({ where: { slug: 'storekeeper' } });
    role ??= await db.role.create({ data: { tenantId, slug: 'storekeeper', name: 'Storekeeper', description: 'Keeps the store: receives goods, issues items to staff, counts stock, sells uniforms and diaries.' } });
    const des = await db.masterValue.findFirst({ where: { master: 'designation', name: { startsWith: 'Sub Staff' } }, select: { id: true } });
    const sk = des ? await db.staff.findFirst({ where: { isDemo: true, designationId: des.id }, orderBy: [{ userId: { sort: 'asc', nulls: 'first' } }, { employeeCode: 'desc' }], select: { id: true, firstName: true, lastName: true, userId: true } }) : null;
    let storekeeper: string | null = null;
    let keeperUser: string | null = null;
    if (sk) {
        let userId = sk.userId;
        if (!userId) {
            let username = `${sk.firstName}.${sk.lastName ?? ''}`.toLowerCase().replace(/[^a-z.]/g, '');
            for (let i = 2; await db.user.findFirst({ where: { username } }); i++) username = `${sk.firstName}.${sk.lastName ?? ''}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
            const u = await db.user.create({ data: { tenantId, kind: 'staff', username, displayName: [sk.firstName, sk.lastName].filter(Boolean).join(' '), passwordHash: await hashPassword(PASSWORD), mustChangePassword: false, isDemo: true } });
            await db.staff.update({ where: { id: sk.id }, data: { userId: u.id } });
            userId = u.id;
        }
        await db.userRole.createMany({ data: [{ tenantId, userId, roleId: role.id }], skipDuplicates: true });
        keeperUser = userId;
        storekeeper = (await db.user.findFirst({ where: { id: userId }, select: { username: true } }))?.username ?? null;
    }
    const office = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } });
    const by = keeperUser ?? office?.id ?? null;
    const today = todayIST();
    const ago = (d: number) => new Date(Date.now() - d * DAY);
    const isoIn = (d: number) => isoOf(new Date(dayDate(today).getTime() + d * DAY));

    // Items with opening stock 70 days ago.
    const { prefix } = await getSettings({ prefix: INVENTORY.itemPrefix });
    const items: { id: string; name: string; store: string; rate: number; cat: string }[] = [];
    let moves = 0;
    for (const [name, cat, unit, reorder, qty, rate, store, x] of ITEMS) {
        const it = await db.invItem.create({ data: { tenantId, code: await nextNumber('inv_item', prefix), name, categoryId: id('inv_category', cat), unitId: id('inv_unit', unit), reorderLevel: reorder, reorderQty: reorder * 2, sellable: !!x?.sell, sellPrice: x?.sell ?? null, trackExpiry: x?.expiry !== undefined, gstPct: x?.gst ?? 0, isDemo: true } });
        await applyMove(tx, { itemId: it.id, storeId: id('inv_store', store)!, kind: 'opening', qty: qty + Math.ceil(qty * 0.6), rate: Math.round(rate * (1 + (x?.gst ?? 0) / 100)), expiryOn: x?.expiry !== undefined ? isoIn(x.expiry) : null, batchNo: x?.expiry !== undefined ? `B${Math.floor(1000 + rand() * 9000)}` : null, refType: 'opening', note: 'Opening stock', userId: by, at: ago(70), isDemo: true }, true);
        items.push({ id: it.id, name, store, rate, cat });
        moves++;
    }
    const item = (n: string) => items.find((i) => i.name.startsWith(n))!;
    const store = (n: string) => id('inv_store', n)!;

    // Two months of issues to departments (brings some items under their reorder level).
    const depts = ['Administration', 'Science', 'Languages', 'Mathematics', 'Social Science', 'Computer Science', 'Support staff', 'Library'].map((d) => id('department', d)).filter((x): x is string => !!x);
    const staffList = await db.staff.findMany({ where: { isDemo: true, status: 'working' }, select: { id: true, departmentId: true }, take: 40 });
    const out = items.filter((i) => !['Uniform', 'Books & diaries'].includes(i.cat));
    for (let n = 0; n < 45; n++) {
        const i = pick(out);
        const st = pick(staffList);
        const stock = await db.invStock.findFirst({ where: { itemId: i.id, storeId: store(i.store) } });
        const q = Math.max(1, Math.floor((stock?.qty ?? 0) * (0.08 + rand() * 0.12)));
        if (!stock || stock.qty < q) continue;
        await applyMove(tx, { itemId: i.id, storeId: store(i.store), kind: 'issue', qty: -q, departmentId: st?.departmentId ?? pick(depts) ?? null, staffId: st?.id ?? null, refType: 'issue', refNo: await nextNumber('inv_issue', 'ISS-'), userId: by, at: ago(60 - n), isDemo: true }, true);
        moves++;
    }
    // Make sure a few are low.
    for (const n of ['A4 paper', 'Whiteboard marker (black)', 'Floor cleaner', 'Toner (HP', 'Garbage bags', 'Basketball', 'Band-aid']) {
        const i = item(n);
        const stock = await db.invStock.findFirst({ where: { itemId: i.id, storeId: store(i.store) } });
        const it = await db.invItem.findFirst({ where: { id: i.id }, select: { reorderLevel: true } });
        const take = Math.max(0, (stock?.qty ?? 0) - Math.floor((it?.reorderLevel ?? 0) * 0.6));
        if (take > 0) {
            await applyMove(tx, { itemId: i.id, storeId: store(i.store), kind: 'issue', qty: -take, departmentId: pick(depts) ?? null, refType: 'issue', refNo: await nextNumber('inv_issue', 'ISS-'), userId: by, at: ago(5), isDemo: true }, true);
            moves++;
        }
    }

    // Purchase orders: one received, one half received, one waiting for approval.
    const { p } = await getSettings({ p: INVENTORY.poPrefix });
    const po = async (vendor: string, lines: [string, number][], status: string, daysAgo: number) =>
        db.invPurchaseOrder.create({ data: { tenantId, number: await nextNumber('inv_po', p), vendorId: id('asset_vendor', vendor), storeId: store('Main store'), orderDate: dayDate(isoIn(-daysAgo)), expectedOn: dayDate(isoIn(-daysAgo + 7)), status, total: Math.round(lines.reduce((a, [n, q]) => a + q * item(n).rate * 1.12, 0)), createdBy: by, approvedBy: status === 'pending' ? null : office?.id ?? null, approvedAt: status === 'pending' ? null : ago(daysAgo), isDemo: true, createdAt: ago(daysAgo), lines: { create: lines.map(([n, q]) => ({ itemId: item(n).id, qty: q, rate: item(n).rate, gstPct: 12 })) } } });
    const po1 = await po('Doon Stationers', [['Chart paper', 200], ['File folder', 100], ['Register (200', 30], ['Cello tape', 40]], 'approved', 50);
    await receive({ source: 'po', poId: po1.id, storeId: store('Main store'), billNo: 'DS/2026/1184', billDate: isoIn(-47), lines: [['Chart paper', 200], ['File folder', 100], ['Register (200', 30], ['Cello tape', 40]].map(([n, q]) => ({ itemId: item(n as string).id, qty: q as number, rate: item(n as string).rate, gstPct: 12 })) }, by!, { at: ago(47), isDemo: true });
    const po2 = await po('Garhwal Scientific Traders', [['Test tube', 200], ['Beaker', 30], ['Glass slide', 10]], 'approved', 12);
    await receive({ source: 'po', poId: po2.id, storeId: store('Science lab store'), billNo: 'GST/889', billDate: isoIn(-8), lines: [{ itemId: item('Test tube').id, qty: 100, rate: item('Test tube').rate, gstPct: 12 }, { itemId: item('Beaker').id, qty: 30, rate: item('Beaker').rate, gstPct: 12 }] }, by!, { at: ago(8), isDemo: true });
    await po('Doon Stationers', [['A4 paper', 60], ['Whiteboard marker (black)', 20], ['Toner (HP', 4], ['Answer sheet', 80]], 'pending', 1);
    await receive({ source: 'direct', vendorId: id('asset_vendor', 'Chamoli Medical'), storeId: store('Main store'), billNo: 'CMS-442', billDate: isoIn(-20), lines: [{ itemId: item('ORS packet').id, qty: 50, rate: 22, gstPct: 0, batchNo: 'ORS26', expiryOn: isoIn(240) }] }, by!, { at: ago(20), isDemo: true });
    moves += 8;

    // Requests: Deepak's (approved, to issue), one waiting for approval, one issued.
    const deepak = await db.staff.findFirst({ where: { user: { username: 'deepak.rautela' } }, select: { id: true, userId: true, departmentId: true } });
    const { p: rp } = await getSettings({ p: INVENTORY.requestPrefix });
    const req = async (who: { id: string; userId: string | null; departmentId: string | null } | null, lines: [string, number][], status: string, daysAgo: number, purpose: string) => {
        if (!who) return;
        const value = Math.round(lines.reduce((a, [n, q]) => a + q * item(n).rate, 0));
        const r = await db.invRequest.create({ data: { tenantId, number: await nextNumber('inv_request', rp), requestedBy: who.userId, staffId: who.id, departmentId: who.departmentId, purpose, status, value, isDemo: true, createdAt: ago(daysAgo), lines: { create: lines.map(([n, q]) => ({ itemId: item(n).id, qty: q, issuedQty: status === 'issued' ? q : 0 })) } } });
        if (status === 'issued') for (const [n, q] of lines) await applyMove(tx, { itemId: item(n).id, storeId: store(item(n).store), kind: 'issue', qty: -q, departmentId: who.departmentId, staffId: who.id, refType: 'request', refId: r.id, refNo: r.number, userId: by, at: ago(daysAgo - 1), isDemo: true }, true);
    };
    await req(deepak ? { id: deepak.id, userId: deepak.userId, departmentId: deepak.departmentId } : null, [['Chart paper', 20], ['Whiteboard marker (blue)', 1], ['Glue stick', 10]], 'approved', 1, 'Class VII-B project work');
    const others = await db.staff.findMany({ where: { isDemo: true, userId: { not: null }, id: { not: deepak?.id } }, select: { id: true, userId: true, departmentId: true }, take: 3 });
    await req(others[0] ?? null, [['Football', 3], ['Volleyball', 3], ['Cones', 2]], 'pending', 2, 'Inter-house sports week');
    await req(others[1] ?? null, [['Register (200', 5], ['Ball pen (blue)', 2]], 'issued', 9, 'Exam duty');
    await req(deepak ? { id: deepak.id, userId: deepak.userId, departmentId: deepak.departmentId } : null, [['Duster', 2], ['Chalk (white', 2]], 'issued', 15, 'Classroom');

    // A write-off waiting for approval, and an expired batch.
    await db.invAdjustment.create({ data: { tenantId, kind: 'writeoff', itemId: item('Test tube').id, storeId: store('Science lab store'), qty: -12, reason: 'damaged', note: 'Broken during practicals (class X)', askedBy: by, isDemo: true } });

    // Sales: uniforms and diaries (Shubham's go to his fees).
    const students = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', isDemo: true } }, select: { studentId: true }, take: 300 });
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const buyers = [...(shubham ? [shubham.id] : []), ...Array.from({ length: 11 }, () => pick(students)?.studentId).filter((x): x is string => !!x)];
    const sellable = ['Shirt', 'Trousers', 'Tie', 'Belt', 'School diary', 'Notebook (ruled', 'House T-shirt', 'Sweater', 'ID card holder'];
    for (const [k, sid] of buyers.entries()) {
        const lines = Array.from(new Set([pick(sellable), pick(sellable), k === 0 ? 'School diary' : pick(sellable)])).map((n) => ({ itemId: item(n).id, qty: n.startsWith('Notebook') ? 6 : 1 }));
        await sell({ studentId: sid, storeId: store('Main store'), payAt: k % 4 === 3 ? 'counter' : 'fees', mode: k % 4 === 3 ? 'Cash' : null, lines }, by!, { at: ago(30 - k * 2), isDemo: true });
        moves++;
    }
    return { items: items.length, moves, storekeeper };
};

export const clearDemoInventory = async () => {
    await db.invSale.deleteMany({ where: { isDemo: true } });
    await db.invAdjustment.deleteMany({ where: { isDemo: true } });
    await db.invRequest.deleteMany({ where: { isDemo: true } });
    await db.invReceipt.deleteMany({ where: { isDemo: true } });
    await db.invPurchaseOrder.deleteMany({ where: { isDemo: true } });
    await db.invCount.deleteMany({ where: { isDemo: true } });
    await db.invItem.deleteMany({ where: { isDemo: true } });
};
