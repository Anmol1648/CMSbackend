import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { makeTenant, makeUser, resetDatabase, resetRateLimits, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let admin: string;
let year: string;
let classVI: string;
let sectionVI: string;
let instA: string; // due 60 days ago (late fine)
let instB: string; // due 5 days ago (within the grace days)
let instC: string; // due in 30 days
let boy: string;
let girl: string;

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    patch: (p: string, body: object) => request(app).patch(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    delete: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});
const inAlpha = <T>(fn: () => Promise<T>) => runAsTenant(alpha.tenant.id, fn);
const settings = (changes: object) => as(admin).patch('/api/settings', { changes });
const option = async (list: string, name: string) => ((await as(admin).get(`/api/masters/${list}/options`)).body.data as { id: string; name: string }[]).find((o) => o.name === name)!.id;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const fees = async (studentId: string) => (await as(admin).get(`/api/fees/students/${studentId}?year=${year}`)).body.data;

const admit = async (firstName: string, gender: string, mobile: string) => {
    const r = await as(admin).post('/api/students', {
        student: { firstName, lastName: 'Test', dateOfBirth: '2014-04-01', genderId: await option('gender', gender) },
        guardians: [{ name: `Parent of ${firstName}`, mobile, isPrimary: true }],
        enrolment: { academicYearId: year, sectionId: sectionVI },
    });
    expect(r.status).toBe(201);
    return r.body.data.student.id as string;
};

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
    admin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    year = ((await as(admin).get('/api/academic/years')).body.data as { id: string; isCurrent: boolean }[]).find((y) => y.isCurrent)!.id;
    classVI = ((await as(admin).get('/api/academic/classes/options')).body.data as { id: string; shortName: string }[]).find((c) => c.shortName === 'VI')!.id;
    sectionVI = ((await as(admin).get(`/api/academic/sections/options?year=${year}`)).body.data as { id: string; label: string }[]).find((s) => s.label.startsWith('VI-A'))!.id;
    await settings({ 'fees.late_fine_mode': 'fixed', 'fees.late_fine_amount': 50, 'fees.late_fine_grace_days': 10, 'students.parent_login': 'on_request', 'fees.new_student_from': 'all' });
    boy = await admit('Rohit', 'Male', '9800000001');
    girl = await admit('Meera', 'Female', '9800000002');
}, 480_000);

describe('fee set-up', () => {
    it('makes instalments (by plan, or one by one) within the year', async () => {
        const gen = await as(admin).post(`/api/fees/setup/instalments/generate?year=${year}`, { plan: 'quarterly', dueDay: 10 });
        expect(gen.status).toBe(201);
        expect(gen.body.data.map((i: { name: string }) => i.name)).toEqual(['Quarter 1', 'Quarter 2', 'Quarter 3', 'Quarter 4']);
        expect((await as(admin).post(`/api/fees/setup/instalments/generate?year=${year}`, { plan: 'monthly' })).status).toBe(409);
        // Replace them with dates around today, so the test doesn't depend on the calendar.
        for (const i of gen.body.data) await as(admin).delete(`/api/fees/setup/instalments/${i.id}`);
        for (const [name, due] of [['A', day(-60)], ['B', day(-5)], ['C', day(30)]]) await as(admin).post(`/api/fees/setup/instalments?year=${year}`, { name, dueDate: due });
        const list = (await as(admin).get(`/api/fees/setup/instalments?year=${year}`)).body.data as { id: string; name: string }[];
        [instA, instB, instC] = ['A', 'B', 'C'].map((n) => list.find((i) => i.name === n)!.id);
        expect((await as(admin).post(`/api/fees/setup/instalments?year=${year}`, { name: 'Far', dueDate: '2099-01-01' })).status).toBe(400);
    });

    it('saves a class’s amounts and copies them to other classes', async () => {
        const [vvn, tui, adm] = await Promise.all([option('fee_head', 'Vidyalaya Vikas Nidhi (VVN)'), option('fee_head', 'Tuition fee'), option('fee_head', 'Admission fee')]);
        const amounts = [instA, instB, instC].flatMap((i) => [
            { feeHeadId: vvn, instalmentId: i, amount: 1000 },
            { feeHeadId: tui, instalmentId: i, amount: 500 },
        ]);
        amounts.push({ feeHeadId: adm, instalmentId: instA, amount: 25 });
        const r = await as(admin).put(`/api/fees/setup/structure/${classVI}?year=${year}`, { amounts });
        expect(r.status).toBe(200);
        expect(r.body.data.total).toBe(4525);
        const classVII = ((await as(admin).get('/api/academic/classes/options')).body.data as { id: string; shortName: string }[]).find((c) => c.shortName === 'VII')!.id;
        expect((await as(admin).post(`/api/fees/setup/structure/${classVI}/copy?year=${year}`, { toClassIds: [classVII] })).body.data.classes).toBe(1);
        const overview = (await as(admin).get(`/api/fees/setup/structure?year=${year}`)).body.data as { id: string; total: number }[];
        expect(overview.find((c) => c.id === classVII)!.total).toBe(4525);
    });

    it('an automatic concession applies by itself; a manual one is given to a student', async () => {
        const tui = await option('fee_head', 'Tuition fee');
        const vvn = await option('fee_head', 'Vidyalaya Vikas Nidhi (VVN)');
        const noCondition = await as(admin).post(`/api/fees/setup/concessions?year=${year}`, { name: 'Everyone', automatic: true, lines: [{ feeHeadId: tui, kind: 'percent', value: 100 }] });
        expect(noCondition.status).toBe(400);
        const girls = await as(admin).post(`/api/fees/setup/concessions?year=${year}`, { name: 'Girls – no tuition', automatic: true, genderIds: [await option('gender', 'Female')], lines: [{ feeHeadId: tui, kind: 'percent', value: 100 }] });
        expect(girls.status).toBe(201);
        const staffWard = await as(admin).post(`/api/fees/setup/concessions?year=${year}`, { name: 'Staff ward', automatic: false, lines: [{ feeHeadId: vvn, kind: 'amount', value: 200 }] });
        expect(staffWard.status).toBe(201);
        expect((await fees(girl)).dues.instalments.find((i: { id: string }) => i.id === instB).net).toBe(1000);
        const given = await as(admin).post(`/api/fees/students/${boy}/concessions`, { concessionId: staffWard.body.data.id, note: 'Father in KVS' });
        expect(given.body.data.dues.instalments.find((i: { id: string }) => i.id === instB).net).toBe(1300);
        await as(admin).delete(`/api/fees/students/${boy}/concessions/${given.body.data.concessions[0].id}`);
    });
});

describe('dues', () => {
    it('adds the admission fee for new students and the late fine after the grace days', async () => {
        const d = (await fees(boy)).dues;
        const [a, b, c] = [instA, instB, instC].map((id) => d.instalments.find((i: { id: string }) => i.id === id));
        expect(a).toMatchObject({ net: 1525, fine: { charged: 50, balance: 50 }, balance: 1575, overdue: true });
        expect(b).toMatchObject({ net: 1500, fine: { charged: 0 }, overdue: true });
        expect(c).toMatchObject({ net: 1500, overdue: false });
        expect(d.totals).toMatchObject({ net: 4525, balance: 4575, overdue: 3075 });
    });

    it('a student admitted during the year pays from the instalment they join in, or the next (a setting)', async () => {
        const line = (d: { instalments: { id: string; net: number; lines: { head: string }[] }[] }, id: string) => d.instalments.find((i) => i.id === id);
        await settings({ 'fees.new_student_from': 'current' });
        let d = (await fees(boy)).dues;
        // Joined after B fell due: A is not charged; the admission fee moves to B.
        expect(line(d, instA)).toBeUndefined();
        expect(line(d, instB)).toMatchObject({ net: 1525 });
        expect(line(d, instB)!.lines.map((l) => l.head)).toContain('Admission fee');
        await settings({ 'fees.new_student_from': 'next' });
        d = (await fees(boy)).dues;
        expect(line(d, instB)).toBeUndefined();
        expect(line(d, instC)).toMatchObject({ net: 1525 });
        await settings({ 'fees.new_student_from': 'all' });
        expect((await fees(boy)).dues.totals.net).toBe(4525);
    });
});

describe('the fee counter', () => {
    it('takes a payment, oldest instalment first, with a receipt number by the pattern', async () => {
        const r = await as(admin).post('/api/fees/receipts', { studentId: boy, mode: 'cash', amount: 2000 });
        expect(r.status).toBe(201);
        const yyyy = new Date().getUTCFullYear();
        expect(r.body.data.receiptNo).toBe(`RCP/${yyyy}/00001`);
        expect(r.body.data.instalments.map((i: { name: string; fine: number }) => `${i.name}:${i.fine}`)).toEqual(['A:50', 'B:0']);
        expect(r.body.data.amount).toBe(2000);
        const d = (await fees(boy)).dues;
        expect(d.instalments.find((i: { id: string }) => i.id === instA).balance).toBe(0);
        expect(d.instalments.find((i: { id: string }) => i.id === instB).balance).toBe(1075);
    });

    it('refuses more than is due, a missing cheque number, and part payment when switched off', async () => {
        expect((await as(admin).post('/api/fees/receipts', { studentId: boy, mode: 'cash', amount: 999_999 })).body.error.details[0]).toMatchObject({ field: 'amount' });
        expect((await as(admin).post('/api/fees/receipts', { studentId: boy, mode: 'cheque', amount: 100 })).body.error.details).toEqual([{ field: 'reference', message: 'is required for this mode' }]);
        await settings({ 'fees.partial_payment': false });
        expect((await as(admin).post('/api/fees/receipts', { studentId: boy, mode: 'cash', amount: 100 })).status).toBe(400);
        await settings({ 'fees.partial_payment': true });
    });

    it('a cancelled receipt brings the dues back, and needs fee.cancel', async () => {
        const r = await as(admin).post('/api/fees/receipts', { studentId: girl, mode: 'upi', reference: 'UPI123', amount: 500 });
        const office = await makeUser(alpha.tenant.id, 'office1', 'office-staff');
        expect((await as(tokenFor(office)).post(`/api/fees/receipts/${r.body.data.id}/cancel`, { reason: 'Wrong student' })).status).toBe(403);
        const before = (await fees(girl)).dues.totals.paid;
        const c = await as(admin).post(`/api/fees/receipts/${r.body.data.id}/cancel`, { reason: 'Wrong student' });
        expect(c.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong student' });
        expect((await fees(girl)).dues.totals.paid).toBe(before - 500);
    });

    it('waives a fine and adds a one-off charge', async () => {
        const fine = (await fees(girl)).dues.instalments.find((i: { id: string }) => i.id === instA).fine.balance;
        expect(fine).toBe(50);
        expect((await as(admin).post(`/api/fees/students/${girl}/adjustments`, { instalmentId: instA, feeHeadId: 'fine', amount: 20, reason: 'x' })).status).toBe(400);
        const w = await as(admin).post(`/api/fees/students/${girl}/adjustments`, { instalmentId: instA, feeHeadId: 'fine', amount: -50, reason: 'Parent was in hospital' });
        expect(w.body.data.dues.instalments.find((i: { id: string }) => i.id === instA).fine.balance).toBe(0);
        const exam = await option('fee_head', 'Examination fee');
        const x = await as(admin).post(`/api/fees/students/${girl}/adjustments`, { instalmentId: instC, feeHeadId: exam, amount: 150, reason: 'Board registration' });
        expect(x.body.data.dues.instalments.find((i: { id: string }) => i.id === instC).lines.find((l: { head: string }) => l.head === 'Examination fee').net).toBe(150);
    });
});

describe('reports', () => {
    it('lists overdue students and the money collected', async () => {
        const dues = (await as(admin).get(`/api/fees/reports/dues?year=${year}`)).body.data;
        expect(dues.students.map((s: { name: string }) => s.name).sort()).toEqual(['Meera Test', 'Rohit Test']);
        expect(dues.students.find((s: { name: string }) => s.name === 'Rohit Test').overdue).toBe(1075);
        const c = (await as(admin).get(`/api/fees/reports/collection?from=${day(-1)}&to=${day(0)}`)).body.data;
        expect(c.total).toEqual({ count: 1, amount: 2000 });
        expect(c.cancelled).toEqual({ count: 1, amount: 500 });
        expect(c.byHead.find((h: { name: string }) => h.name === 'Late fine').amount).toBe(50);
        const classes = (await as(admin).get(`/api/fees/reports/classes?year=${year}`)).body.data;
        expect(classes.classes.find((x: { id: string }) => x.id === classVI)).toMatchObject({ students: 2, paid: 2000, defaulters: 2 });
    });
});

describe('parents and online payment', () => {
    let parent: string;

    it('a parent sees only their own child in My Fees', async () => {
        const g = await inAlpha(() => db.guardian.findFirstOrThrow({ where: { family: { students: { some: { id: boy } } } } }));
        const login = await as(admin).post(`/api/students/${boy}/guardians/${g.id}/login`);
        expect(login.status).toBe(200);
        const user = await inAlpha(() => db.user.findFirstOrThrow({ where: { username: login.body.data.username } }));
        parent = tokenFor({ id: user.id, tenantId: alpha.tenant.id });
        const mine = (await as(parent).get('/api/fees/my')).body.data;
        expect(mine.children.map((c: { name: string }) => c.name)).toEqual(['Rohit Test']);
        expect(mine.online.enabled).toBe(false);
        expect((await as(parent).get(`/api/fees/students/${girl}`)).status).toBe(403);
    });

    it('pays on the test gateway: the receipt is made once, even if confirmed twice', async () => {
        await as(admin).put('/api/payments/gateway', { provider: 'mock' });
        expect((await as(parent).post('/api/payments/fees', { studentId: boy })).status).toBe(403);
        await settings({ 'payments.online_fees': true, 'payments.convenience_fee_mode': 'percent', 'payments.convenience_fee_value': 2 });
        expect((await as(parent).post('/api/payments/fees', { studentId: girl })).status).toBe(404);
        const start = await as(parent).post('/api/payments/fees', { studentId: boy, instalmentIds: [instB] });
        expect(start.status).toBe(201);
        expect(start.body.data).toMatchObject({ provider: 'mock', amount: 1075 + 22 });
        const paid = await as(parent).post(`/api/payments/${start.body.data.paymentId}/mock`, { outcome: 'paid' });
        expect(paid.body.data).toMatchObject({ status: 'paid', convenienceFee: 22, receipt: { receiptNo: expect.stringMatching(/^RCP\//) } });
        const again = await as(parent).post(`/api/payments/${start.body.data.paymentId}/mock`, { outcome: 'paid' });
        expect(again.body.data.receipt.id).toBe(paid.body.data.receipt.id);
        const receipt = (await as(parent).get(`/api/fees/my/receipts/${paid.body.data.receipt.id}`)).body.data;
        expect(receipt).toMatchObject({ mode: 'online', amount: 1075, online: { convenienceFee: 22 } });
        expect((await fees(boy)).dues.instalments.find((i: { id: string }) => i.id === instB).balance).toBe(0);
        await settings({ 'payments.convenience_fee_mode': 'none' });
    });

    it('accepts a Razorpay webhook only with the right signature', async () => {
        await as(admin).put('/api/payments/gateway', { provider: 'razorpay', keyId: 'rzp_test_abc123', keySecret: 'TestKeySecret0123456789ab', webhookSecret: 'hook-secret' });
        const gw = (await as(admin).get('/api/payments/gateway')).body.data;
        expect(gw).toMatchObject({ provider: 'razorpay', mode: 'test', test: { keyId: 'rzp_test_abc123', hasKeySecret: true, hasWebhookSecret: true, ready: true }, live: { ready: false }, ready: true });
        expect(JSON.stringify(gw)).not.toContain('TestKeySecret0123456789ab');
        // An order as Razorpay would have made it.
        const payment = await inAlpha(() =>
            db.onlinePayment.create({ data: { tenantId: alpha.tenant.id, purpose: 'fees', provider: 'razorpay', orderId: 'order_TEST1', amount: 500, studentId: boy, academicYearId: year, allocation: [] } })
        );
        const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_TEST1', order_id: 'order_TEST1' } } } });
        const send = (signature: string) => request(app).post('/api/public/payments/razorpay/webhook/alpha').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).send(body);
        expect((await send('0'.repeat(64))).status).toBe(401);
        const ok = await send(crypto.createHmac('sha256', 'hook-secret').update(body).digest('hex'));
        expect(ok.status).toBe(200);
        const after = await inAlpha(() => db.onlinePayment.findUniqueOrThrow({ where: { id: payment.id }, include: { receipt: true } }));
        expect(after).toMatchObject({ status: 'paid', paymentRef: 'pay_TEST1', receipt: { mode: 'online', amount: 500 } });
        // The browser's callback is checked the same way.
        const bad = await as(admin).post(`/api/payments/${payment.id}/confirm`, { paymentRef: 'pay_X', signature: 'f'.repeat(64) });
        expect(bad.status).toBe(400);
    });

    it('keeps test and live keys apart: live needs live keys, and a live webhook is checked with the live secret', async () => {
        expect((await as(admin).put('/api/payments/gateway', { provider: 'razorpay', mode: 'live' })).status).toBe(400);
        expect((await as(admin).put('/api/payments/gateway', { provider: 'razorpay', liveKeyId: 'rzp_test_wrong' })).status).toBe(400);
        // A browser's saved password typed into the secret box is refused.
        expect((await as(admin).put('/api/payments/gateway', { provider: 'razorpay', keySecret: 'Demo@2026' })).status).toBe(400);
        const saved = await as(admin).put('/api/payments/gateway', { provider: 'razorpay', mode: 'live', liveKeyId: 'rzp_live_abc123', liveKeySecret: 'LiveKeySecret0123456789ab', liveWebhookSecret: 'live-hook' });
        expect(saved.body.data).toMatchObject({ mode: 'live', live: { keyId: 'rzp_live_abc123', ready: true }, test: { keyId: 'rzp_test_abc123' } });
        expect(JSON.stringify(saved.body.data)).not.toContain('LiveKeySecret0123456789ab');
        const payment = await inAlpha(() =>
            db.onlinePayment.create({ data: { tenantId: alpha.tenant.id, purpose: 'fees', provider: 'razorpay', mode: 'live', orderId: 'order_LIVE1', amount: 100, studentId: boy, academicYearId: year, allocation: [] } })
        );
        const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_LIVE1', order_id: 'order_LIVE1' } } } });
        const ok = await request(app).post('/api/public/payments/razorpay/webhook/alpha').set('Content-Type', 'application/json').set('X-Razorpay-Signature', crypto.createHmac('sha256', 'live-hook').update(body).digest('hex')).send(body);
        expect(ok.status).toBe(200);
        expect((await inAlpha(() => db.onlinePayment.findUniqueOrThrow({ where: { id: payment.id } }))).status).toBe('paid');
        // Back to test mode: the live keys stay saved.
        const back = await as(admin).put('/api/payments/gateway', { provider: 'razorpay', mode: 'test' });
        expect(back.body.data).toMatchObject({ mode: 'test', live: { ready: true } });
    });

    it('takes a fee by UPI QR at the counter: the receipt is made when it is paid', async () => {
        await as(admin).put('/api/payments/gateway', { provider: 'mock' });
        const qr = await as(admin).post('/api/payments/counter-qr', { studentId: girl, amount: 300 });
        expect(qr.status).toBe(201);
        expect(qr.body.data).toMatchObject({ method: 'qr', status: 'created', amount: 300, convenienceFee: 0 });
        expect(qr.body.data.qrImageUrl).toMatch(/^data:image\/svg\+xml/);
        // Not paid yet.
        expect((await as(admin).get(`/api/payments/${qr.body.data.id}/qr`)).body.data.status).toBe('created');
        // The parent scans and pays (the test gateway's "simulate" button).
        const paid = await as(admin).post(`/api/payments/${qr.body.data.id}/mock`, { outcome: 'paid' });
        expect(paid.body.data).toMatchObject({ status: 'paid', receipt: { receiptNo: expect.stringMatching(/^RCP\//) }, qrImageUrl: null });
        const receipt = (await as(admin).get(`/api/fees/receipts/${paid.body.data.receipt.id}`)).body.data;
        expect(receipt).toMatchObject({ mode: 'upi', amount: 300 });
        // A QR the parent walks away from is closed.
        const other = await as(admin).post('/api/payments/counter-qr', { studentId: girl, amount: 100 });
        const closed = await as(admin).post(`/api/payments/${other.body.data.id}/qr/cancel`);
        expect(closed.body.data).toMatchObject({ status: 'failed' });
        // A parent can't poll the cashier's QR.
        const g = await inAlpha(() => db.guardian.findFirstOrThrow({ where: { family: { students: { some: { id: boy } } } }, include: { user: true } }));
        expect((await as(tokenFor({ id: g.userId!, tenantId: alpha.tenant.id })).get(`/api/payments/${other.body.data.id}/qr`)).status).toBe(404);
    });

    it('the website form takes the registration fee online', async () => {
        await resetRateLimits();
        await as(admin).put('/api/payments/gateway', { provider: 'mock' });
        await settings({ 'payments.online_registration': true, 'admissions.registration_fee': 300 });
        const info = (await request(app).get('/api/public/enquiry').set('Origin', ORIGIN)).body.data;
        expect(info.registrationFee).toEqual({ amount: 300, convenienceFee: 0 });
        const sent = await request(app).post('/api/public/enquiry').set('Origin', ORIGIN).send({ classId: classVI, studentFirstName: 'Webby', parentName: 'Web Parent', mobile: '9822200011' });
        expect(sent.body.data.payment).toMatchObject({ provider: 'mock', amount: 300 });
        const paid = await request(app).post(`/api/public/payments/${sent.body.data.payment.paymentId}/mock`).set('Origin', ORIGIN).send({ outcome: 'paid' });
        expect(paid.body.data).toMatchObject({ status: 'paid', registrationNo: expect.stringMatching(/^REG\//) });
        const e = await inAlpha(() => db.enquiry.findFirstOrThrow({ where: { studentFirstName: 'Webby' } }));
        expect(e).toMatchObject({ registrationFee: 300, registrationFeeMode: 'online' });
        const c = (await as(admin).get(`/api/fees/reports/collection?from=${day(-1)}&to=${day(0)}`)).body.data;
        expect(c.registrationFees).toMatchObject({ count: 1, amount: 300 });
    });
});
