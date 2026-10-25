import fs from 'fs';
import path from 'path';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { ASSETS, COMPANY, CONTACT, PRODUCT } from './demo-deck';

/**
 * The prerequisites PDF (Platform console → Prerequisites): everything a school gives us to start,
 * section by section, marked "needed to start" or "can come later", with the Excel columns of each
 * import. Sent to a school after the demo.
 */

type Need = 'start' | 'later' | 'optional';
interface Item {
    what: string;
    detail: string;
    need: Need;
}
interface Section {
    title: string;
    intro?: string;
    items: Item[];
    columns?: { file: string; cols: string[] };
}

const SECTIONS: Section[] = [
    {
        title: 'School profile',
        intro: 'Printed on receipts, report cards, certificates and ID cards.',
        items: [
            { what: 'Legal name and short name', detail: 'As on the affiliation letter; a short name for the app (e.g. “KV Joshimath”)', need: 'start' },
            { what: 'Address, phone, email, website', detail: 'Full postal address with PIN code', need: 'start' },
            { what: 'Board, affiliation no., UDISE code', detail: 'CBSE / ICSE / State board', need: 'start' },
            { what: 'Logo', detail: 'PNG with a clear background, at least 500 × 500 px', need: 'start' },
            { what: 'Principal’s signature and school seal', detail: 'Scanned PNG, for certificates, TCs and report cards', need: 'later' },
            { what: 'Sign-in page photo and quote', detail: 'A photo of the school building (landscape)', need: 'optional' },
        ],
    },
    {
        title: 'Academic set-up',
        items: [
            { what: 'Academic session', detail: 'Start and end dates (e.g. 1 April 2026 – 31 March 2027)', need: 'start' },
            { what: 'Classes and sections', detail: 'Nursery to XII as run by the school; sections (A, B…); streams for XI–XII', need: 'start' },
            { what: 'Subjects of each class', detail: 'Scholastic and co-scholastic subjects; optional subjects (e.g. Hindi / Sanskrit)', need: 'start' },
            { what: 'Class teachers', detail: 'One teacher for each section', need: 'start' },
            { what: 'Bell timings and periods', detail: 'Period times per day (for the timetable)', need: 'later' },
            { what: 'Holiday list', detail: 'Holidays of the session (for attendance and the calendar)', need: 'later' },
            { what: 'Houses', detail: 'House names and colours, if the school has houses', need: 'optional' },
        ],
    },
    {
        title: 'Students',
        intro: 'One Excel sheet for the whole school (our template is in the ERP: Students → Import). Only the first six columns are required.',
        items: [
            { what: 'Student list', detail: 'All current students with their class and section', need: 'start' },
            { what: 'Parents’ mobile numbers', detail: 'Correct and active: parents sign in and receive alerts with these', need: 'start' },
            { what: 'Student photos', detail: 'Passport-size, named by admission no. (e.g. 2025-0235.jpg), for ID cards', need: 'later' },
            { what: 'Previous fee dues', detail: 'Amount still due from last session, per student', need: 'later' },
        ],
        columns: {
            file: 'students.xlsx',
            cols: ['Admission no.*', 'First name*', 'Last name', 'Class*', 'Section*', 'Gender*', 'Date of birth*', 'Roll no.', 'Admission date', 'Father’s name', 'Father’s mobile', 'Mother’s name', 'Mother’s mobile', 'Email', 'Address', 'Category (Gen / OBC / SC / ST)', 'Religion', 'Blood group', 'Aadhaar no. (optional)', 'Transport stop', 'House'],
        },
    },
    {
        title: 'Staff',
        intro: 'One Excel sheet (template: Staff → Import).',
        items: [
            { what: 'Staff list', detail: 'Teaching and non-teaching staff', need: 'start' },
            { what: 'Who teaches what', detail: 'Teacher → class / section → subject', need: 'start' },
            { what: 'Who gets a login and which role', detail: 'Admin, principal, accountant, office, teachers, librarian, warden…', need: 'start' },
            { what: 'Salary details', detail: 'Only if payroll is used: salary structure, bank account, PAN, UAN, ESI no.', need: 'later' },
        ],
        columns: { file: 'staff.xlsx', cols: ['Employee code*', 'First name*', 'Last name', 'Designation*', 'Department', 'Gender', 'Date of birth', 'Date of joining', 'Mobile*', 'Email', 'Qualification', 'Address', 'Bank account / IFSC', 'PAN', 'UAN'] },
    },
    {
        title: 'Fees',
        items: [
            { what: 'Fee heads', detail: 'Tuition, admission, annual, exam, computer, transport, hostel…', need: 'start' },
            { what: 'Fee structure', detail: 'Amount of each head for each class (new and old students if different)', need: 'start' },
            { what: 'Instalments and due dates', detail: 'Monthly / quarterly / yearly, with the last date of each', need: 'start' },
            { what: 'Late fine rules', detail: 'Per day or flat, from which date', need: 'later' },
            { what: 'Concessions', detail: 'Sibling, staff ward, merit, RTE — with the amount or %', need: 'later' },
            { what: 'Receipt book number', detail: 'The next receipt number to continue from', need: 'start' },
            { what: 'Online payment', detail: 'Razorpay account (key id and secret) in the school’s name, if parents will pay online', need: 'optional' },
        ],
    },
    {
        title: 'Exams and report cards',
        items: [
            { what: 'Exam pattern', detail: 'Terms and exams (e.g. PT-1, Half-Yearly, PT-2, Annual) with maximum marks and weightage', need: 'later' },
            { what: 'Grading scale', detail: 'CBSE 9-point or the school’s own', need: 'later' },
            { what: 'Report card sample', detail: 'A filled report card of last year, so ours looks the same', need: 'later' },
        ],
    },
    {
        title: 'Other modules (only those the school uses)',
        items: [
            { what: 'Transport', detail: 'Routes, stops with fares, buses (number, capacity), drivers and helpers with mobiles', need: 'optional' },
            { what: 'Library', detail: 'Book list in Excel: accession no., title, author, publisher, subject, copies', need: 'optional' },
            { what: 'Hostel and mess', detail: 'Hostels, rooms and beds, wardens; mess plans and charges', need: 'optional' },
            { what: 'Store / inventory', detail: 'Items and opening stock', need: 'optional' },
            { what: 'Accounts', detail: 'Opening balances of bank and cash; chart of accounts if the school has one', need: 'optional' },
            { what: 'Certificates and ID card', detail: 'Samples of the school’s TC, bonafide certificate and ID card', need: 'optional' },
            { what: 'Biometric machines', detail: 'Make and model (eSSL / ZKTeco), if staff attendance should come from them', need: 'optional' },
        ],
    },
    {
        title: 'Communication',
        items: [
            { what: 'Email sender', detail: 'Alerts go from our address; for the school’s own (e.g. office@school.in) share its mail settings', need: 'optional' },
            { what: 'SMS / WhatsApp', detail: 'An SMS (DLT registered) or WhatsApp Business provider account, if wanted', need: 'optional' },
            { what: 'Web address', detail: 'The school’s own domain (e.g. erp.school.in) if wanted; otherwise school.klytos.co.in', need: 'optional' },
        ],
    },
];

const NEED: Record<Need, { label: string; css: string }> = { start: { label: 'Needed to start', css: 'start' }, later: { label: 'In the first weeks', css: 'later' }, optional: { label: 'If used', css: 'opt' } };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The page as HTML (also used to preview it). */
export const prerequisitesHtml = () => {
    const logoFile = path.join(ASSETS, 'logo.png');
    const logo = fs.existsSync(logoFile) ? `data:image/png;base64,${fs.readFileSync(logoFile).toString('base64')}` : null;
    const startCount = SECTIONS.flatMap((s) => s.items).filter((i) => i.need === 'start').length;
    const body = `
<header class="head">${logo ? `<img src="${logo}" alt="">` : ''}<div><h1>${esc(PRODUCT)}</h1><p>What we need from the school to start</p></div></header>
<p class="lead">Thank you for choosing ${esc(PRODUCT)}. Please collect the items below. The <b>${startCount} items marked “Needed to start”</b> are enough for us to set up the school; the rest can follow in the first weeks. Excel templates for students and staff are in the ERP (Students → Import, Staff → Import) — we will send them to you.</p>
<div class="legend"><span class="tag start">Needed to start</span><span class="tag later">In the first weeks</span><span class="tag opt">If used</span></div>
${SECTIONS.map(
    (s, n) => `<section>
<h2>${n + 1}. ${esc(s.title)}</h2>${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ''}
<table><thead><tr><th class="c">✓</th><th>What</th><th>Details</th><th class="n">When</th></tr></thead><tbody>
${s.items.map((i) => `<tr><td class="c"><span class="box"></span></td><td><b>${esc(i.what)}</b></td><td>${esc(i.detail)}</td><td class="n"><span class="tag ${NEED[i.need].css}">${NEED[i.need].label}</span></td></tr>`).join('')}
</tbody></table>
${s.columns ? `<p class="cols"><b>Excel columns (${esc(s.columns.file)}):</b> ${s.columns.cols.map(esc).join(' · ')} <i>(* required)</i></p>` : ''}
</section>`
).join('')}
<section class="steps"><h2>What happens next</h2>
<ol><li><b>You share the items</b> marked “Needed to start” (email or WhatsApp is fine).</li><li><b>We set up the school</b>: import students and staff, set fees, classes and templates — usually within a week.</li><li><b>Training</b> for the office, accounts and teachers; parents receive their logins.</li><li><b>Go live</b>, starting with attendance and fees; we stay with you on call and WhatsApp.</li></ol>
<p class="contact">Questions? ${esc(COMPANY)} · ${esc(CONTACT.phone)} · ${esc(CONTACT.email)}</p></section>`;
    const css = `body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5px; color: #1f2937; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 3px solid #1A365D; padding-bottom: 8px; }
.head img { width: 54px; height: 54px; object-fit: contain; }
.head h1 { margin: 0; font-size: 20px; color: #1A365D; }
.head p { margin: 2px 0 0; font-size: 13px; color: #8B6B10; font-weight: 600; }
.lead { font-size: 11.5px; line-height: 1.55; margin: 10px 0 6px; }
.legend { margin: 6px 0 4px; display: flex; gap: 8px; }
h2 { font-size: 13.5px; color: #1A365D; margin: 14px 0 4px; }
.intro { margin: 0 0 4px; color: #4b5563; }
section { break-inside: avoid-page; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th:nth-child(2) { width: 32%; }
th { background: #1A365D; color: #fff; text-align: left; padding: 5px 6px; font-size: 10px; }
td { border-bottom: 1px solid #e5e7eb; padding: 5px 6px; vertical-align: top; }
td.c, th.c { width: 18px; text-align: center; }
td.n, th.n { width: 108px; }
.box { display: inline-block; width: 10px; height: 10px; border: 1.3px solid #1A365D; border-radius: 2px; }
.tag { display: inline-block; border-radius: 9px; padding: 1px 7px; font-size: 9px; font-weight: 700; white-space: nowrap; }
.tag.start { background: #FEE2E2; color: #991B1B; }
.tag.later { background: #FEF3C7; color: #92400E; }
.tag.opt { background: #E0E7FF; color: #3730A3; }
.cols { background: #F8FAFC; border: 1px dashed #CBD5E1; padding: 6px 8px; margin: 6px 0 0; line-height: 1.5; }
.steps ol { margin: 4px 0; padding-left: 18px; line-height: 1.7; font-size: 11px; }
.contact { margin-top: 10px; font-weight: 700; color: #1A365D; }`;
    return pageHtml(body, css, PAPER);
};

const PAPER = { size: 'A4' as const, orientation: 'portrait' as const, margin: 12 };
export const prerequisitesPdf = () => htmlToPdf(prerequisitesHtml(), PAPER, `${PRODUCT} · Prerequisites | Page {page} of {pages}`);
