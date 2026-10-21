import QRCode from 'qrcode';
import type { DataScope } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { getUserAccess } from '../rbac/access.service';
import { scopeWhere as studentScope, fullName } from '../students/students.service';
import { defineDocument } from '../documents/documents.registry';
import { inWords } from '../documents/documents.service';
import { FEES } from './fees.settings';
import { computeDues, dueStudents } from './dues.service';
import { getReceipt, Viewer } from './receipts.service';
import { PAYMENT_MODE_LABELS } from './fees.labels';

/** The fee documents: the receipt and the due slip (a reminder of what is to be paid). */

const viewerOf = async (userId: string): Promise<Viewer> => {
    const access = await getUserAccess(userId);
    const scope = (access.permissions['fee.view'] ?? (access.permissions['fee.collect'] ? 'all' : 'own')) as DataScope;
    return { userId, scope };
};
const uuid = (v: string | undefined, what: string) => {
    if (!v || !z.uuid().safeParse(v).success) throw badRequest(`Choose the ${what}`);
    return v;
};

// ─── Receipt ─────────────────────────────────────────────────────────────────

const receiptData = async (r: Awaited<ReturnType<typeof getReceipt>>) => {
    const { note } = await getSettings({ note: FEES.receiptNote });
    const qr = await QRCode.toDataURL(`Fee receipt ${r.receiptNo} | ${r.student.admissionNo} ${r.student.name} | Rs ${r.amount} | ${r.date}${r.status === 'cancelled' ? ' | CANCELLED' : ''}`, { margin: 0, width: 160 });
    return {
        receipt: {
            ...r,
            modeLabel: PAYMENT_MODE_LABELS[r.mode] ?? r.mode,
            amountInWords: inWords(r.amount),
            cancelled: r.status === 'cancelled',
            qr,
            footer: note,
        },
    };
};

const RECEIPT_HTML = `{{#if receipt.cancelled}}<div class="watermark">CANCELLED</div>{{/if}}
<header class="head">
  {{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}
  <div class="school">
    <h1>{{school.name}}</h1>
    <p>{{school.address}}</p>
    <p>{{#if school.phone}}Ph: {{school.phone}}{{/if}}{{#if school.email}} · {{school.email}}{{/if}}</p>
    {{#if school.affiliationNo}}<p>Affiliation no. {{school.affiliationNo}}{{#if school.udiseCode}} · UDISE {{school.udiseCode}}{{/if}}</p>{{/if}}
  </div>
  <div class="title">
    <h2>FEE RECEIPT</h2>
    <p class="mono">{{receipt.receiptNo}}</p>
    <p>{{date receipt.date}}</p>
    <p class="copy">{{copy}}</p>
  </div>
</header>

<table class="info">
  <tr><td>Student</td><td><b>{{receipt.student.name}}</b></td><td>Admission no.</td><td class="mono"><b>{{receipt.student.admissionNo}}</b></td></tr>
  <tr><td>Class</td><td><b>{{receipt.student.section}}</b>{{#if receipt.student.roll}} · Roll {{receipt.student.roll}}{{/if}}</td><td>Session</td><td><b>{{receipt.academicYear.name}}</b></td></tr>
  {{#if receipt.parent}}<tr><td>{{#if receipt.parent.relation}}{{receipt.parent.relation}}{{else}}Parent{{/if}}</td><td colspan="3"><b>{{receipt.parent.name}}</b></td></tr>{{/if}}
</table>

<table class="lines">
  <thead><tr><th>Particulars</th><th class="r">Amount</th></tr></thead>
  <tbody>
  {{#each receipt.instalments}}
    <tr class="inst"><td colspan="2">{{name}}</td></tr>
    {{#each lines}}<tr><td class="sub">{{head}}{{#if refundable}} (refundable){{/if}}</td><td class="r">{{rupees amount}}</td></tr>{{/each}}
    {{#if fine}}<tr><td class="sub">Late fine</td><td class="r">{{rupees fine}}</td></tr>{{/if}}
  {{/each}}
  </tbody>
  <tfoot><tr><td>Total received</td><td class="r">{{rupees receipt.amount}}</td></tr></tfoot>
</table>

<div class="bottom">
  <div>
    <p>Rupees <b>{{receipt.amountInWords}}</b> only</p>
    <p>Paid by <b>{{receipt.modeLabel}}</b>{{#if receipt.reference}} · ref {{receipt.reference}}{{/if}}{{#if receipt.bankName}} · {{receipt.bankName}}{{/if}}</p>
    {{#if receipt.note}}<p class="note">{{receipt.note}}</p>{{/if}}
    {{#if receipt.cancelled}}<p class="cancel">Cancelled{{#if receipt.cancelledBy}} by {{receipt.cancelledBy}}{{/if}}: {{receipt.cancelReason}}</p>{{/if}}
    <p class="footer">{{receipt.footer}}</p>
  </div>
  <div class="sign">
    <img class="qr" src="{{receipt.qr}}" alt="">
    <p>{{#if receipt.online}}Paid online{{else}}Received by{{#if receipt.collectedBy}} {{receipt.collectedBy}}{{/if}}{{/if}}</p>
  </div>
</div>`;

const RECEIPT_CSS = `.document-page { position: relative; }
.head { display: flex; align-items: center; gap: 12px; border-bottom: 1.5px solid #1a365d; padding-bottom: 8px; }
.logo { width: 52px; height: 52px; object-fit: contain; }
.school { flex: 1; }
.school h1 { margin: 0 0 2px; font-size: 15px; text-transform: uppercase; color: #1a365d; }
.school p { margin: 0; font-size: 9.5px; color: #333; }
.title { text-align: right; }
.title h2 { margin: 0; font-size: 12px; letter-spacing: 1px; color: #1a365d; }
.title p { margin: 1px 0 0; font-size: 10px; }
.copy { font-size: 8.5px !important; text-transform: uppercase; letter-spacing: 1px; color: #666; }
.mono { font-family: Consolas, 'Courier New', monospace; }
.info { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10.5px; }
.info td { padding: 2px 4px; }
.info td:nth-child(odd) { color: #555; width: 16%; }
.lines { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.lines th { text-align: left; border-bottom: 1px solid #1a365d; padding: 3px 4px; font-size: 9.5px; text-transform: uppercase; color: #1a365d; }
.lines td { padding: 2px 4px; }
.lines .inst td { font-weight: 700; padding-top: 5px; }
.lines .sub { padding-left: 14px; }
.lines tfoot td { border-top: 1.5px solid #1a365d; font-weight: 800; padding-top: 4px; }
.r { text-align: right; }
.bottom { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 8px; font-size: 10.5px; }
.bottom p { margin: 2px 0; }
.note { font-style: italic; }
.cancel { color: #b91c1c; font-weight: 700; }
.footer { font-size: 8.5px; color: #555; margin-top: 8px !important; }
.sign { text-align: center; min-width: 130px; }
.sign .qr { width: 58px; height: 58px; }
.sign p { border-top: 1px solid #333; padding-top: 3px; margin-top: 4px; font-size: 9.5px; }
.watermark { position: absolute; top: 38%; left: 0; right: 0; text-align: center; font-size: 64px; font-weight: 900; color: rgba(185, 28, 28, 0.16); transform: rotate(-12deg); pointer-events: none; }`;

defineDocument({
    key: 'fee_receipt',
    label: 'Fee receipt',
    description: 'Given for every fee payment (counter, online, UPI QR). One A4 sheet with a copy for the school and one for the parent, to cut apart.',
    fields: [
        { key: 'receipt.receiptNo', label: 'Receipt number' },
        { key: 'receipt.date', label: 'Receipt date (use {{date receipt.date}})' },
        { key: 'receipt.amount', label: 'Amount received (use {{rupees receipt.amount}})' },
        { key: 'receipt.amountInWords', label: 'Amount in words' },
        { key: 'receipt.modeLabel', label: 'Paid by (Cash, UPI, Cheque…)' },
        { key: 'receipt.reference', label: 'Cheque / transaction number' },
        { key: 'receipt.bankName', label: 'Bank (cheque / DD)' },
        { key: 'receipt.student.name / admissionNo / section / roll', label: 'Student' },
        { key: 'receipt.parent.name / relation', label: 'Parent (main contact)' },
        { key: 'receipt.academicYear.name', label: 'Session' },
        { key: '#each receipt.instalments → name, lines (head, amount), fine', label: 'What was paid, by instalment' },
        { key: 'receipt.collectedBy', label: 'Who collected it' },
        { key: 'receipt.cancelled / cancelReason', label: 'Cancelled? and why' },
        { key: 'receipt.qr', label: 'QR code with the receipt details (as an image)' },
        { key: 'receipt.footer', label: 'Note set in System Settings → Fees' },
    ],
    html: RECEIPT_HTML,
    css: RECEIPT_CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 10, copies: ['School copy', 'Parent copy'], copiesOnOnePage: true },
    sample: async () => {
        const latest = await db.feeReceipt.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
        if (latest) {
            const r = await getReceipt(latest.id, { userId: '', scope: 'all' });
            return { data: await receiptData(r), filename: `receipt-${r.receiptNo.replace(/[^A-Za-z0-9]+/g, '-')}.pdf` };
        }
        const sample = {
            id: 'sample',
            receiptNo: 'RCP/2026/00001',
            date: new Date().toISOString().slice(0, 10),
            student: { id: 'sample', name: 'Aarav Sharma', admissionNo: '2026/0001', section: 'VI-A', roll: 12 },
            parent: { name: 'Rajesh Sharma', relation: 'Father', mobile: '9800000000' },
            academicYear: { id: 'sample', name: '2026–27' },
            mode: 'cash',
            reference: null,
            bankName: null,
            amount: 1825,
            note: null,
            status: 'active',
            cancelledAt: null,
            cancelledBy: null,
            cancelReason: null,
            collectedBy: 'Accountant',
            online: null,
            createdAt: new Date(),
            instalments: [{ id: 's', name: 'Quarter 1 (Apr–Jun)', dueDate: '2026-04-15', fine: 0, lines: [{ head: 'Vidyalaya Vikas Nidhi (VVN)', amount: 1500, refundable: false }, { head: 'Computer fund', amount: 300, refundable: false }, { head: 'Admission fee', amount: 25, refundable: false }] }],
        } as unknown as Awaited<ReturnType<typeof getReceipt>>;
        return { data: await receiptData(sample), filename: 'receipt-sample.pdf' };
    },
    load: async (params, userId) => {
        const r = await getReceipt(uuid(params.id, 'receipt'), await viewerOf(userId));
        return { data: await receiptData(r), filename: `receipt-${r.receiptNo.replace(/[^A-Za-z0-9]+/g, '-')}.pdf` };
    },
});

// ─── Due slip ────────────────────────────────────────────────────────────────

/** A student who owes something, to preview the slip with (looked up again after 10 minutes). */
const sampleCache = new Map<string, { at: number; studentId: string | null }>();
const sampleStudentWithDues = async (yearId: string) => {
    const hit = sampleCache.get(yearId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.studentId;
    const students = (await dueStudents(yearId, { status: 'active' })).slice(0, 60);
    const dues = await computeDues(yearId, students);
    const found = students.find((s) => (dues.get(s.id)?.totals.overdue ?? 0) > 0) ?? students.find((s) => (dues.get(s.id)?.totals.balance ?? 0) > 0) ?? null;
    sampleCache.set(yearId, { at: Date.now(), studentId: found?.id ?? null });
    return found?.id ?? null;
};

/** Slips for students (one, or everyone of a section with something to pay). */
const slips = async (where: { studentId?: string; sectionId?: string }, viewer: Viewer, asOf: string) => {
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year is set');
    const scope = await studentScope({ userId: viewer.userId, scope: viewer.scope, sensitive: false });
    let students = await dueStudents(year.id, { AND: [scope, ...(where.studentId ? [{ id: where.studentId }] : [])] });
    if (where.sectionId) students = students.filter((s) => s.sectionId === where.sectionId);
    if (!students.length) throw notFound('Student not found');
    const dues = await computeDues(year.id, students, { asOf });
    const info = await db.student.findMany({
        where: { id: { in: students.map((s) => s.id) } },
        select: {
            id: true,
            admissionNo: true,
            firstName: true,
            middleName: true,
            lastName: true,
            family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, mobile: true, relation: { select: { name: true } } } } } },
            enrolments: { where: { academicYearId: year.id }, select: { rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } },
        },
    });
    const out = info
        .map((s) => {
            const d = dues.get(s.id)!;
            const e = s.enrolments[0];
            const open = d.instalments.filter((i) => i.balance > 0);
            const g = s.family?.guardians[0];
            return {
                student: { name: fullName(s), admissionNo: s.admissionNo, section: e ? `${e.section.schoolClass.shortName ?? e.section.schoolClass.name}-${e.section.name}` : '—', roll: e?.rollNumber ?? null },
                parent: g ? { name: g.name, mobile: g.mobile, relation: g.relation?.name ?? null } : null,
                year: year.name,
                asOf,
                instalments: open.map((i) => ({ name: i.name, dueDate: i.dueDate, overdue: i.overdue, fees: i.lines.reduce((a, l) => a + Math.max(0, l.balance), 0), fine: i.fine.balance, balance: i.balance })),
                totals: { ...d.totals, inWords: inWords(d.totals.balance) },
                order: (e?.rollNumber ?? 999) * 1 + 0,
            };
        })
        .filter((s) => where.studentId || s.totals.balance > 0)
        .sort((a, b) => a.order - b.order);
    if (!out.length) throw badRequest('Nobody in this section has fees to pay');
    return out.map(({ order: _o, ...s }) => s);
};

const SLIP_HTML = `<header class="head">
  {{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}
  <div class="school"><h1>{{school.name}}</h1><p>{{school.address}}</p>{{#if school.phone}}<p>Ph: {{school.phone}}</p>{{/if}}</div>
</header>
<h2 class="title">FEE DUE SLIP · {{year}}</h2>
<table class="info">
  <tr><td>Student</td><td><b>{{student.name}}</b></td><td>Admission no.</td><td><b>{{student.admissionNo}}</b></td></tr>
  <tr><td>Class</td><td><b>{{student.section}}</b>{{#if student.roll}} · Roll {{student.roll}}{{/if}}</td><td>As on</td><td><b>{{date asOf}}</b></td></tr>
  {{#if parent}}<tr><td>{{#if parent.relation}}{{parent.relation}}{{else}}Parent{{/if}}</td><td colspan="3"><b>{{parent.name}}</b>{{#if parent.mobile}} · {{parent.mobile}}{{/if}}</td></tr>{{/if}}
</table>
<p>Dear parent, the following fees of your ward are to be paid:</p>
<table class="lines">
  <thead><tr><th>Instalment</th><th>Due date</th><th class="r">Fees</th><th class="r">Late fine</th><th class="r">To pay</th></tr></thead>
  <tbody>
  {{#each instalments}}<tr{{#if overdue}} class="late"{{/if}}><td>{{name}}{{#if overdue}} (overdue){{/if}}</td><td>{{date dueDate}}</td><td class="r">{{rupees fees}}</td><td class="r">{{#if fine}}{{rupees fine}}{{else}}—{{/if}}</td><td class="r"><b>{{rupees balance}}</b></td></tr>{{/each}}
  </tbody>
  <tfoot><tr><td colspan="4">Total to pay</td><td class="r">{{rupees totals.balance}}</td></tr></tfoot>
</table>
<p>Rupees <b>{{totals.inWords}}</b> only{{#if totals.overdue}}, of which <b>{{rupees totals.overdue}}</b> is already overdue{{/if}}.</p>
<p class="small">Please pay at the school fee counter, or online in My Fees (UPI, card or net banking). Ignore this slip if already paid.</p>
<div class="sign"><p>Accounts Office</p></div>`;

const SLIP_CSS = `.head { display: flex; align-items: center; gap: 10px; border-bottom: 1.5px solid #1a365d; padding-bottom: 6px; }
.logo { width: 44px; height: 44px; object-fit: contain; }
.school h1 { margin: 0; font-size: 14px; text-transform: uppercase; color: #1a365d; }
.school p { margin: 0; font-size: 9px; color: #333; }
.title { text-align: center; font-size: 12px; letter-spacing: 1px; color: #1a365d; margin: 8px 0 4px; }
.info { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 10.5px; }
.info td { padding: 2px 4px; }
.info td:nth-child(odd) { color: #555; }
.lines { width: 100%; border-collapse: collapse; font-size: 10.5px; margin: 6px 0; }
.lines th { text-align: left; border-bottom: 1px solid #1a365d; padding: 3px 4px; font-size: 9px; text-transform: uppercase; color: #1a365d; }
.lines td { padding: 3px 4px; border-bottom: 1px solid #eee; }
.lines tr.late td { color: #b91c1c; }
.lines tfoot td { border-top: 1.5px solid #1a365d; font-weight: 800; }
.r { text-align: right; }
p { margin: 4px 0; font-size: 10.5px; }
.small { font-size: 9px; color: #555; }
.sign { text-align: right; margin-top: 26px; }
.sign p { display: inline-block; border-top: 1px solid #333; padding: 3px 20px 0; }`;

defineDocument({
    key: 'fee_due_slip',
    label: 'Fee due slip',
    description: 'A reminder of what a student still has to pay (overdue in red), for one student or a whole section at once (a page each).',
    fields: [
        { key: 'student.name / admissionNo / section / roll', label: 'Student' },
        { key: 'parent.name / mobile / relation', label: 'Parent (main contact)' },
        { key: 'year', label: 'Session' },
        { key: 'asOf', label: 'Dues as on (use {{date asOf}})' },
        { key: '#each instalments → name, dueDate, overdue, fees, fine, balance', label: 'Instalments with something to pay' },
        { key: 'totals.balance / overdue / fine / paid / net / inWords', label: 'Totals' },
    ],
    html: SLIP_HTML,
    css: SLIP_CSS,
    paper: { size: 'A5', orientation: 'portrait', margin: 10, copies: ['Parent copy'] },
    sample: async () => {
        const year = await currentYear();
        const someone = year ? await sampleStudentWithDues(year.id) : null;
        if (someone) {
            try {
                const [s] = await slips({ studentId: someone }, { userId: '', scope: 'all' }, new Date().toISOString().slice(0, 10));
                return { data: s, filename: 'due-slip-sample.pdf' };
            } catch {
                // Fall back to the made-up one below.
            }
        }
        return {
            data: {
                student: { name: 'Aarav Sharma', admissionNo: '2026/0001', section: 'VI-A', roll: 12 },
                parent: { name: 'Rajesh Sharma', mobile: '9800000000', relation: 'Father' },
                year: '2026–27',
                asOf: new Date().toISOString().slice(0, 10),
                instalments: [{ name: 'Quarter 2 (Jul–Sep)', dueDate: '2026-07-15', overdue: true, fees: 1800, fine: 50, balance: 1850 }],
                totals: { balance: 1850, overdue: 1850, fine: 50, paid: 1825, net: 7225, inWords: inWords(1850) },
            },
            filename: 'due-slip-sample.pdf',
        };
    },
    load: async (params, userId) => {
        const viewer = await viewerOf(userId);
        const asOf = params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf) ? params.asOf : new Date().toISOString().slice(0, 10);
        if (params.section) {
            const list = await slips({ sectionId: uuid(params.section, 'section') }, viewer, asOf);
            return { data: list[0], many: list, filename: `due-slips-${list[0].student.section}.pdf` };
        }
        const [s] = await slips({ studentId: uuid(params.student, 'student') }, viewer, asOf);
        return { data: s, filename: `due-slip-${s.student.admissionNo.replace(/[^A-Za-z0-9]+/g, '-')}.pdf` };
    },
});
