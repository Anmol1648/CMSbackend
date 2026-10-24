import { db } from '../../core/db';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { createVoucher, defaultBank, ensureChart, fyOf, saveBudgets, saveOpenings, systemLedger } from './accounts.service';
import { markSalaryPaid, syncAll } from './posting.service';

/**
 * Demo accounts: the bank account's details, opening balances; everything posted since the start
 * of the financial year from fees, payroll, the store and staff loans; salaries marked paid; monthly
 * electricity, phone, fuel, repairs and bank charges; cash deposited in the bank; part of a vendor
 * paid; bank interest; a ₹45,000 payment waiting for the principal; budgets; the bank reconciled up
 * to three weeks ago. Vouchers are marked is_demo.
 */

let seed = 4_646;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));

export const createDemoAccounts = async () => {
    if (await db.accVoucher.count({ where: { isDemo: true } })) return { vouchers: 0 };
    await ensureChart();
    const today = todayIST();
    const fy = await fyOf(today);
    const bank = await defaultBank();
    await db.accLedger.update({ where: { id: bank }, data: { name: 'State Bank of India (current a/c)', details: { bank: 'State Bank of India', accountNo: '38291045567', ifsc: 'SBIN0007211', branch: 'Joshimath' } } });
    const cash = await systemLedger('cash');
    const L = async (name: string) => (await db.accLedger.findFirst({ where: { name }, select: { id: true } }))!.id;
    const [furniture, computers, fund, electricity, phone, fuel, vehicle, buildingRep, bankCharges, events, interest, printing] = await Promise.all(['Furniture and fixtures', 'Computers and equipment', 'General fund', 'Electricity', 'Telephone and internet', 'Fuel', 'Vehicle maintenance', 'Building repairs', 'Bank charges', 'Events and functions', 'Bank interest', 'Printing and stationery'].map(L));
    await saveOpenings({ yearStart: fy.start, openings: { [cash]: 25000, [bank]: 6500000, [furniture]: 600000, [computers]: 350000, [fund]: -7475000 } });

    // Everything the other modules did since the year began.
    await syncAll({ from: fy.start, isDemo: true });
    const runs = await db.payrollRun.findMany({ where: { status: 'finalised' }, select: { month: true } });
    const office = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'accountant' } } } }, select: { id: true } });
    const principal = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'principal' } } } }, select: { id: true } });
    for (const r of runs) {
        const [y, m] = r.month.split('-').map(Number);
        const paidOn = isoOf(new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 7)));
        if (paidOn <= today) await markSalaryPaid({ month: r.month, date: paidOn, bankLedgerId: bank, reference: `NEFT batch ${r.month}` }, principal?.id ?? office?.id ?? '', { isDemo: true }).catch(() => null);
    }

    // Monthly running costs and cash deposits.
    const v = (type: 'receipt' | 'payment' | 'contra' | 'journal', date: string, narration: string, lines: { ledgerId: string; dr: number; cr: number }[], reference?: string) =>
        createVoucher({ type, date, narration, reference: reference ?? null, attachmentId: null, lines, source: 'manual', isDemo: true }, principal?.id ?? null, { approve: true });
    let count = 0;
    for (let d = fy.start; d <= today; d = addDays(d, 1)) {
        const dom = Number(d.slice(8, 10));
        if (dom === 10) {
            const amt = Math.round(15000 + rand() * 8000);
            await v('payment', d, `Electricity bill (UPCL) for ${new Date(`${addDays(d, -15)}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })}`, [{ ledgerId: electricity, dr: amt, cr: 0 }, { ledgerId: bank, dr: 0, cr: amt }], `NEFT ${Math.floor(rand() * 900000 + 100000)}`);
            await v('payment', d, 'Broadband and phones (BSNL)', [{ ledgerId: phone, dr: 2950, cr: 0 }, { ledgerId: bank, dr: 0, cr: 2950 }]);
            count += 2;
        }
        if (dom === 5 || dom === 20) {
            const amt = Math.round(18000 + rand() * 9000);
            await v('payment', d, 'Diesel for school buses (Garhwal Fuels)', [{ ledgerId: fuel, dr: amt, cr: 0 }, { ledgerId: bank, dr: 0, cr: amt }], `CHQ ${Math.floor(rand() * 900000 + 100000)}`);
            count++;
        }
        if (dom === 28) {
            await v('payment', d, 'Bank charges', [{ ledgerId: bankCharges, dr: 118, cr: 0 }, { ledgerId: bank, dr: 0, cr: 118 }]);
            count++;
        }
        // Cash collected at the counter is deposited every Saturday (keeping ₹10,000 in hand).
        if (dayDate(d).getUTCDay() === 6) {
            const bal = await db.accEntry.aggregate({ where: { ledgerId: cash, voucher: { status: 'posted', date: { lte: dayDate(d) } } }, _sum: { dr: true, cr: true } });
            const inHand = 25000 + (bal._sum.dr ?? 0) - (bal._sum.cr ?? 0);
            const dep = Math.floor((inHand - 10000) / 1000) * 1000;
            if (dep > 0) {
                await v('contra', d, 'Cash deposited in the bank', [{ ledgerId: bank, dr: dep, cr: 0 }, { ledgerId: cash, dr: 0, cr: dep }], `Deposit slip ${Math.floor(rand() * 90000 + 10000)}`);
                count++;
            }
        }
    }
    const mid = addDays(fy.start, 120);
    if (mid <= today) {
        await v('payment', mid, 'Roof waterproofing of the science block', [{ ledgerId: buildingRep, dr: 68500, cr: 0 }, { ledgerId: bank, dr: 0, cr: 68500 }], 'CHQ 552901');
        await v('payment', addDays(mid, 14), 'Bus servicing and tyres', [{ ledgerId: vehicle, dr: 24800, cr: 0 }, { ledgerId: bank, dr: 0, cr: 24800 }]);
        await v('payment', addDays(mid, 30), 'Printing of report cards and diaries', [{ ledgerId: printing, dr: 9400, cr: 0 }, { ledgerId: cash, dr: 0, cr: 9400 }]);
        await v('receipt', addDays(fy.start, 182) <= today ? addDays(fy.start, 182) : mid, 'Half-yearly savings interest', [{ ledgerId: bank, dr: 7350, cr: 0 }, { ledgerId: interest, dr: 0, cr: 7350 }]);
        count += 4;
    }
    // Part of what the store owes a vendor is paid.
    const vendor = await db.accLedger.findFirst({ where: { systemKey: { startsWith: 'vendor:' } }, select: { id: true, name: true } });
    if (vendor) {
        await v('payment', addDays(today, -12), `Part payment to ${vendor.name}`, [{ ledgerId: vendor.id, dr: 10000, cr: 0 }, { ledgerId: bank, dr: 0, cr: 10000 }], 'NEFT 778120');
        count++;
    }
    // A big payment waiting for the principal (made by the accountant, above the limit).
    await createVoucher({ type: 'payment', date: addDays(today, -1), narration: 'Annual day: stage, lights and sound (Shiv Tent House)', reference: 'Quote 2026/118', attachmentId: null, lines: [{ ledgerId: events, dr: 45000, cr: 0 }, { ledgerId: bank, dr: 0, cr: 45000 }], source: 'manual', isDemo: true }, office?.id ?? null);
    count++;
    // Budgets for the year.
    await saveBudgets({ yearStart: fy.start, budgets: { [electricity]: 240000, [phone]: 36000, [fuel]: 520000, [vehicle]: 80000, [buildingRep]: 150000, [bankCharges]: 2000, [events]: 120000, [printing]: 40000, [await systemLedger('salary_expense')]: 30000000 } });
    // The bank is reconciled up to three weeks ago.
    const upTo = addDays(today, -21);
    const entries = await db.accEntry.findMany({ where: { ledgerId: bank, voucher: { status: 'posted', date: { lte: dayDate(upTo) } } }, include: { voucher: { select: { date: true } } } });
    for (const e of entries) await db.accEntry.update({ where: { id: e.id }, data: { reconciledOn: dayDate(addDays(isoOf(e.voucher.date), e.dr > 0 ? 1 : 2)) } });
    await db.accVoucher.updateMany({ where: { isDemo: false, source: { not: 'manual' } }, data: { isDemo: true } });
    return { vouchers: await db.accVoucher.count({ where: { isDemo: true } }), count };
};

export const clearDemoAccounts = async () => {
    await db.accVoucher.deleteMany({ where: { isDemo: true } });
};
