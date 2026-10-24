import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { seedMasters } from '../masters/masters.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { ASSETS } from './assets.settings';

/**
 * Demo assets: about 150 entries over the labs, classrooms, office, staff room, hall and store
 * (rooms added to Masters → Rooms & labs when missing), laptops with teachers (one with Deepak
 * Rautela), vendors, open and fixed problems, maintenance due / overdue, warranties ending soon,
 * one write-off waiting for the principal and one done. Marked is_demo.
 */

let seed = 5_151;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;

const ROOMS = [
    { name: 'Office', code: 'OFFICE' },
    { name: 'Principal’s Office', code: 'PRIN' },
    { name: 'Staff Room', code: 'STAFF' },
    { name: 'Store Room', code: 'STORE' },
    { name: 'Assembly Hall', code: 'HALL' },
    { name: 'Room 101 (VI-A)', code: 'R101' },
    { name: 'Room 102 (VI-B)', code: 'R102' },
    { name: 'Room 201 (VII-A)', code: 'R201' },
    { name: 'Room 202 (VII-B)', code: 'R202' },
    { name: 'Room 301 (VIII-A)', code: 'R301' },
    { name: 'Room 302 (VIII-B)', code: 'R302' },
];
const VENDORS = [
    { name: 'Doon Computers', extra: { phone: '9412000111', gstin: '05ABCDE1234F1Z5' } },
    { name: 'Himalaya Furniture Works', extra: { phone: '9412000222', gstin: '' } },
    { name: 'Safe Fire Services', extra: { phone: '9412000333', gstin: '' } },
    { name: 'Garhwal Electricals', extra: { phone: '9412000444', gstin: '' } },
];

export const createDemoAssets = async () => {
    const tenantId = getTenantId()!;
    if (await db.asset.count({ where: { isDemo: true } })) return { assets: 0, issues: 0 };
    await seedMasters();
    if (!(await db.masterValue.findFirst({ where: { master: 'notification_type', code: 'assets' } }))) await db.masterValue.create({ data: { tenantId, master: 'notification_type', name: 'Assets', code: 'assets', sortOrder: 99, extra: { icon: 'inventory_2' } } });
    let order = (await db.masterValue.count({ where: { master: 'room' } })) + 1;
    for (const r of ROOMS) if (!(await db.masterValue.findFirst({ where: { master: 'room', name: r.name } }))) await db.masterValue.create({ data: { tenantId, master: 'room', name: r.name, code: r.code, sortOrder: order++, extra: {} } });
    for (const v of VENDORS) if (!(await db.masterValue.findFirst({ where: { master: 'asset_vendor', name: v.name } }))) await db.masterValue.create({ data: { tenantId, master: 'asset_vendor', name: v.name, sortOrder: 0, extra: v.extra } });

    const values = await db.masterValue.findMany({ where: { master: { in: ['room', 'asset_category', 'asset_condition', 'asset_vendor'] } }, select: { id: true, name: true, master: true, extra: true } });
    const id = (master: string, name: string) => values.find((v) => v.master === master && v.name.startsWith(name))?.id ?? null;
    const room = (n: string) => id('room', n);
    const cat = (n: string) => id('asset_category', n);
    const cond = (n: string) => id('asset_condition', n);
    const vendor = (n: string) => id('asset_vendor', n);
    const every = (catId: string | null) => Number(((values.find((v) => v.id === catId)?.extra ?? {}) as { maintain_every?: number }).maintain_every ?? 0);

    const office = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } });
    const principal = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'principal' } } } }, select: { id: true } });
    const teachers = await db.staff.findMany({ where: { isDemo: true, userId: { not: null }, user: { roles: { some: { role: { slug: { in: ['teacher', 'class-teacher'] } } } } } }, select: { id: true, userId: true, firstName: true }, orderBy: { firstName: 'asc' }, take: 12 });
    const deepak = await db.staff.findFirst({ where: { user: { username: 'deepak.rautela' } }, select: { id: true, userId: true } });

    const s = await getSettings({ prefix: ASSETS.codePrefix, digits: ASSETS.codeDigits });
    const today = todayIST();
    const ago = (days: number) => dayDate(isoOf(new Date(dayDate(today).getTime() - days * DAY)));
    const ahead = (days: number) => dayDate(isoOf(new Date(dayDate(today).getTime() + days * DAY)));
    const created: { id: string; name: string; roomId: string | null }[] = [];

    const add = async (name: string, o: { cat: string; room?: string; qty?: number; cost: number; daysOld: number; make?: string; model?: string; serial?: string; cond?: string; vendor?: string; warrantyDays?: number; amcDays?: number; nextDays?: number; staffId?: string | null; status?: string }) => {
        const categoryId = cat(o.cat);
        const m = every(categoryId);
        const code = `${s.prefix}${String(await takeNumbers('asset', 1)).padStart(s.digits, '0')}`;
        const a = await db.asset.create({
            data: {
                tenantId,
                code,
                name,
                categoryId,
                conditionId: cond(o.cond ?? (o.daysOld < 200 ? 'New' : o.daysOld < 900 ? 'Good' : 'Fair')),
                vendorId: o.vendor ? vendor(o.vendor) : null,
                roomId: o.room ? room(o.room) : null,
                staffId: o.staffId ?? null,
                make: o.make ?? null,
                model: o.model ?? null,
                serialNo: o.serial ?? null,
                quantity: o.qty ?? 1,
                purchasedOn: ago(o.daysOld),
                billNo: `INV-${1000 + Math.floor(rand() * 9000)}`,
                cost: o.cost,
                warrantyUntil: o.warrantyDays !== undefined ? ahead(o.warrantyDays) : null,
                amcUntil: o.amcDays !== undefined ? ahead(o.amcDays) : null,
                maintainEvery: m || null,
                nextMaintenanceOn: m ? ahead(o.nextDays ?? 15 + Math.floor(rand() * 300)) : null,
                status: o.status ?? 'in_use',
                isDemo: true,
                createdBy: office?.id ?? null,
                createdAt: ago(o.daysOld),
            },
        });
        await db.assetEvent.create({ data: { tenantId, assetId: a.id, kind: 'added', toRoomId: a.roomId, toStaffId: a.staffId, userId: office?.id ?? null, at: ago(o.daysOld) } });
        created.push({ id: a.id, name, roomId: a.roomId });
        return a;
    };

    // Classrooms: desks, chairs, boards, fans, a smart board in some.
    for (const r of ['Room 101', 'Room 102', 'Room 201', 'Room 202', 'Room 301', 'Room 302']) {
        await add('Student desk (double)', { cat: 'Furniture', room: r, qty: 20, cost: 20 * 3200, daysOld: 1400, vendor: 'Himalaya' });
        await add('Teacher table and chair', { cat: 'Furniture', room: r, cost: 6500, daysOld: 1400, vendor: 'Himalaya' });
        await add('Green board', { cat: 'Furniture', room: r, cost: 4800, daysOld: 1400 });
        await add('Ceiling fan', { cat: 'Electrical', room: r, qty: 4, cost: 4 * 2100, daysOld: 1100, make: 'Usha', vendor: 'Garhwal' });
        if (r.endsWith('1')) await add('Smart board', { cat: 'Projectors', room: r, cost: 85000, daysOld: 500, make: 'BenQ', model: 'RM6503', serial: `BQ${Math.floor(rand() * 1e7)}`, vendor: 'Doon', warrantyDays: 230 });
    }
    // Computer lab.
    for (let i = 1; i <= 30; i++) await add(`Desktop computer ${String(i).padStart(2, '0')}`, { cat: 'Computers', room: 'Computer Lab', cost: 38000, daysOld: 700, make: 'Dell', model: 'OptiPlex 3000', serial: `DL3K${10000 + i * 37}`, vendor: 'Doon', warrantyDays: i <= 3 ? 20 : 400, amcDays: 120 });
    await add('Network switch 48-port', { cat: 'Computers', room: 'Computer Lab', cost: 24000, daysOld: 700, make: 'TP-Link', vendor: 'Doon' });
    await add('Projector', { cat: 'Projectors', room: 'Computer Lab', cost: 42000, daysOld: 900, make: 'Epson', model: 'EB-X51', serial: 'EPX5100912', vendor: 'Doon', nextDays: -10 });
    await add('Air conditioner 1.5 ton', { cat: 'Electrical', room: 'Computer Lab', qty: 2, cost: 2 * 36000, daysOld: 900, make: 'Voltas', vendor: 'Garhwal', nextDays: 4 });
    await add('Inverter and batteries', { cat: 'Electrical', room: 'Computer Lab', cost: 55000, daysOld: 1000, make: 'Luminous', vendor: 'Garhwal', amcDays: 25 });
    // Science labs.
    for (const [lab, items] of [
        ['Physics Lab', [['Vernier calipers', 15, 450], ['Screw gauge', 15, 520], ['Spring balance', 20, 180], ['Optical bench', 4, 6500], ['Projector', 1, 40000]]],
        ['Chemistry Lab', [['Lab stool', 40, 900], ['Fume hood', 1, 95000], ['Digital weighing balance', 2, 12500], ['Glassware set', 10, 3800]]],
        ['Biology Lab', [['Compound microscope', 12, 7800], ['Human skeleton model', 1, 9500], ['Specimen cabinet', 2, 14000]]],
    ] as [string, [string, number, number][]][]) {
        for (const [n, q, c] of items) await add(n, { cat: n === 'Projector' ? 'Projectors' : n.includes('stool') || n.includes('cabinet') ? 'Furniture' : 'Lab equipment', room: lab, qty: q, cost: q * c, daysOld: 600 + Math.floor(rand() * 900), vendor: n === 'Projector' ? 'Doon' : undefined, make: n === 'Projector' ? 'Epson' : undefined });
    }
    // Library, office, staff room, principal.
    await add('Book rack (steel)', { cat: 'Furniture', room: 'Library', qty: 12, cost: 12 * 7500, daysOld: 1500 });
    await add('Reading table', { cat: 'Furniture', room: 'Library', qty: 8, cost: 8 * 5200, daysOld: 1500 });
    await add('Library computer', { cat: 'Computers', room: 'Library', cost: 36000, daysOld: 300, make: 'HP', model: 'ProDesk 400', serial: 'HPPD40077', vendor: 'Doon', warrantyDays: 400 });
    await add('Photocopier', { cat: 'Office equipment', room: 'Office', cost: 145000, daysOld: 800, make: 'Canon', model: 'IR 2425', serial: 'CN2425X81', vendor: 'Doon', amcDays: 12, nextDays: 2 });
    await add('Laser printer', { cat: 'Office equipment', room: 'Office', cost: 18500, daysOld: 400, make: 'HP', model: 'LaserJet M211', vendor: 'Doon', warrantyDays: 10 });
    await add('Office computer', { cat: 'Computers', room: 'Office', qty: 3, cost: 3 * 40000, daysOld: 500, make: 'Dell', model: 'Vostro', vendor: 'Doon' });
    await add('CCTV system (16 cameras + NVR)', { cat: 'Electrical', room: 'Office', cost: 165000, daysOld: 600, make: 'Hikvision', vendor: 'Garhwal', amcDays: 200 });
    await add('Steel almirah', { cat: 'Furniture', room: 'Office', qty: 4, cost: 4 * 11000, daysOld: 2000 });
    await add('Water cooler with RO', { cat: 'Electrical', room: 'Staff Room', cost: 48000, daysOld: 700, make: 'Blue Star', vendor: 'Garhwal', nextDays: -3 });
    await add('Staff room table', { cat: 'Furniture', room: 'Staff Room', qty: 3, cost: 3 * 9000, daysOld: 1800 });
    await add('Staff chair', { cat: 'Furniture', room: 'Staff Room', qty: 25, cost: 25 * 1800, daysOld: 1800 });
    await add('Executive table', { cat: 'Furniture', room: 'Principal', cost: 28000, daysOld: 1200 });
    await add('Air conditioner 1 ton', { cat: 'Electrical', room: 'Principal', cost: 32000, daysOld: 600, make: 'Daikin', vendor: 'Garhwal' });
    // Hall, ground, store.
    await add('PA system (amplifier, 4 speakers, 3 mics)', { cat: 'Projectors', room: 'Assembly Hall', cost: 68000, daysOld: 900, make: 'Ahuja', vendor: 'Garhwal' });
    await add('Plastic chair', { cat: 'Furniture', room: 'Assembly Hall', qty: 300, cost: 300 * 650, daysOld: 1300 });
    await add('Harmonium', { cat: 'Musical', room: 'Assembly Hall', cost: 14000, daysOld: 1600 });
    await add('Tabla set', { cat: 'Musical', room: 'Assembly Hall', cost: 9000, daysOld: 1600 });
    await add('Drum set (band)', { cat: 'Musical', room: 'Assembly Hall', qty: 6, cost: 6 * 5500, daysOld: 1000 });
    await add('Football goal posts', { cat: 'Sports', room: 'Playground', qty: 2, cost: 2 * 18000, daysOld: 1700 });
    await add('Basketball pole set', { cat: 'Sports', room: 'Playground', qty: 2, cost: 2 * 32000, daysOld: 1700 });
    await add('Cricket kit', { cat: 'Sports', room: 'Store Room', qty: 3, cost: 3 * 8500, daysOld: 400 });
    await add('Table tennis table', { cat: 'Sports', room: 'Store Room', cost: 22000, daysOld: 900 });
    await add('Spare desks', { cat: 'Furniture', room: 'Store Room', qty: 15, cost: 15 * 3200, daysOld: 2200, cond: 'Needs repair' });
    // Fire safety everywhere (6-monthly refills; some overdue).
    let k = 0;
    for (const r of ['Office', 'Computer Lab', 'Chemistry Lab', 'Physics Lab', 'Library', 'Assembly Hall', 'Staff Room', 'Store Room']) await add('Fire extinguisher (ABC 6 kg)', { cat: 'Fire safety', room: r, qty: 2, cost: 2 * 2800, daysOld: 500, vendor: 'Safe Fire', nextDays: k++ < 3 ? -5 - k * 7 : 3 + k * 20 });
    // Laptops with teachers.
    const laptopFor = [...(deepak ? [deepak] : []), ...teachers.filter((t) => t.id !== deepak?.id).slice(0, 7)];
    let n = 0;
    for (const t of laptopFor) {
        const a = await add('Teacher laptop', { cat: 'Computers', staffId: t.id, room: 'Staff Room', cost: 52000, daysOld: 250 + n * 30, make: 'Lenovo', model: 'ThinkPad E14', serial: `LNVE14${5000 + n * 11}`, vendor: 'Doon', warrantyDays: n === 0 ? 18 : 300 + n * 20 });
        await db.assetEvent.create({ data: { tenantId, assetId: a.id, kind: 'assigned', toStaffId: t.id, userId: office?.id ?? null, at: ago(240 + n * 30), note: 'For classes and marks entry' } });
        n++;
    }
    await add('Tablet for attendance', { cat: 'Computers', room: 'Office', qty: 4, cost: 4 * 14000, daysOld: 150, make: 'Samsung', model: 'Galaxy Tab A9', vendor: 'Doon', warrantyDays: 210 });

    // A written-off asset and one waiting for the principal.
    const old = await add('Old CRT monitor', { cat: 'Computers', room: 'Store Room', qty: 6, cost: 6 * 8000, daysOld: 3600, cond: 'Out of use', status: 'disposed' });
    await db.asset.update({ where: { id: old.id }, data: { disposedOn: ago(40) } });
    await db.assetDisposal.create({ data: { tenantId, assetId: old.id, reason: 'scrapped', note: 'E-waste collected by the municipal recycler', amount: 1200, status: 'approved', askedBy: office?.id ?? null, answeredBy: principal?.id ?? null, answeredAt: ago(40), isDemo: true, createdAt: ago(42) } });
    await db.assetEvent.create({ data: { tenantId, assetId: old.id, kind: 'disposed', note: 'scrapped for ₹1200: E-waste collected by the municipal recycler', userId: principal?.id ?? null, at: ago(40) } });
    const broken = await add('Old desktop computer', { cat: 'Computers', room: 'Store Room', qty: 1, cost: 32000, daysOld: 2800, cond: 'Damaged', make: 'HCL' });
    await db.assetDisposal.create({ data: { tenantId, assetId: broken.id, reason: 'sold', note: 'Motherboard dead; a dealer offers ₹1,500', amount: 1500, status: 'pending', askedBy: office?.id ?? null, isDemo: true } });

    // Problems: open, in repair, fixed.
    const find = (name: string, roomName?: string) => created.find((c) => c.name === name && (!roomName || c.roomId === room(roomName)));
    const reporter = (i: number) => teachers[i % Math.max(1, teachers.length)]?.userId ?? office?.id ?? null;
    let issues = 0;
    const issue = async (a: { id: string } | undefined, title: string, o: { status?: string; by?: string | null; daysAgo: number; cost?: number; resolution?: string; vendorName?: string; details?: string }) => {
        if (!a) return;
        await db.assetIssue.create({ data: { tenantId, assetId: a.id, title, details: o.details ?? null, reportedBy: o.by ?? reporter(issues), status: o.status ?? 'open', assignedTo: o.status && o.status !== 'open' ? (office?.id ?? null) : null, vendorId: o.vendorName ? vendor(o.vendorName) : null, cost: o.cost ?? null, resolution: o.resolution ?? null, fixedAt: o.status === 'fixed' ? ago(Math.max(0, o.daysAgo - 2)) : null, isDemo: true, createdAt: ago(o.daysAgo) } });
        if (o.status === 'in_repair') await db.asset.update({ where: { id: a.id }, data: { status: 'in_repair' } });
        if (o.status === 'fixed') await db.assetEvent.create({ data: { tenantId, assetId: a.id, kind: 'repaired', cost: o.cost ?? null, note: `${title}: ${o.resolution}`, userId: office?.id ?? null, at: ago(Math.max(0, o.daysAgo - 2)) } });
        issues++;
    };
    await issue(find('Projector', 'Physics Lab'), 'Projector not turning on', { daysAgo: 1, by: deepak?.userId ?? null, details: 'The power light blinks red; nothing on the screen.' });
    await issue(find('Desktop computer 07'), 'Keyboard keys not working', { daysAgo: 3 });
    await issue(find('Ceiling fan', 'Room 202'), 'One fan makes a loud noise', { daysAgo: 2, by: deepak?.userId ?? null });
    await issue(find('Water cooler with RO'), 'Water not cold', { daysAgo: 6, status: 'in_repair', vendorName: 'Garhwal' });
    await issue(find('Desktop computer 12'), 'Does not boot (hard disk)', { daysAgo: 9, status: 'in_repair', vendorName: 'Doon' });
    await issue(find('Photocopier'), 'Paper jam every few copies', { daysAgo: 25, status: 'fixed', cost: 1800, resolution: 'Pickup roller replaced under AMC (paid part)', vendorName: 'Doon' });
    await issue(find('Smart board', 'Room 201'), 'Touch not working on the left side', { daysAgo: 40, status: 'fixed', cost: 0, resolution: 'Recalibrated by the vendor (warranty)', vendorName: 'Doon' });
    await issue(find('Air conditioner 1.5 ton'), 'Water dripping inside', { daysAgo: 60, status: 'fixed', cost: 950, resolution: 'Drain pipe cleaned, gas checked', vendorName: 'Garhwal' });

    // Maintenance done earlier.
    for (const a of created.filter((c) => c.name.startsWith('Fire extinguisher')).slice(3)) await db.assetEvent.create({ data: { tenantId, assetId: a.id, kind: 'maintained', cost: 900, note: 'Refilled and pressure tested', userId: office?.id ?? null, at: ago(170) } });

    return { assets: created.length, issues };
};

export const clearDemoAssets = async () => {
    await db.assetVerification.deleteMany({ where: { isDemo: true } });
    await db.asset.deleteMany({ where: { isDemo: true } });
};
