import fs from 'fs';
import path from 'path';
import PptxGenJS from 'pptxgenjs';

/**
 * The demo deck (Platform console → Demo deck): the problem schools have, what the ERP is, what it
 * solves, who uses it, then the real screens (assets/demo-deck/*.jpg, taken by
 * `npm run demo:screens`), security and how a school goes live. Made fresh on each download.
 */

export const PRODUCT = process.env.PLATFORM_NAME ? `${process.env.PLATFORM_NAME} School ERP` : 'Klytos School ERP';
export const COMPANY = 'Klytos Labs';
export const CONTACT = { phone: process.env.PLATFORM_CONTACT_PHONE || '+91 74529 38683', email: process.env.PLATFORM_CONTACT_EMAIL || process.env.PLATFORM_LEADS_EMAIL || 'anmolkothiyal2021@gmail.com' };
export const ASSETS = path.join(process.cwd(), 'assets');

export interface DeckScreen {
    key: string;
    /** Who is signed in when the screenshot is taken (mobile = the parent on a phone). */
    as: 'none' | 'admin' | 'teacher' | 'parent' | 'student' | 'mobile';
    path: string;
    section: string;
    title: string;
    points: string[];
}

/** The screens, in the order of the deck. */
export const DECK_SCREENS: DeckScreen[] = [
    { key: 'website', as: 'none', path: '/', section: 'First look', title: 'The school’s own website and sign-in', points: ['Product website in English and Hindi', 'One sign-in page for everyone: staff, parents, students', 'Each school can have its own address and logo'] },
    { key: 'admin-home', as: 'admin', path: '/home', section: 'First look', title: 'Dashboard: the school at a glance', points: ['Today’s attendance, fee collection, admissions and alerts', 'Each role sees its own widgets; drag to arrange', 'Build new widgets from any data, no coding'] },
    { key: 'students', as: 'admin', path: '/students', section: 'Office & admissions', title: 'Students: every record in one place', points: ['Search, filter by class, house, status; export to Excel', 'Import a whole school from Excel in minutes', 'Promotion, TC and certificates in a click'] },
    { key: 'student-profile', as: 'admin', path: '/students/:student', section: 'Office & admissions', title: 'A student’s complete profile', points: ['Details, family, class history and documents', 'Fees, attendance, results, conduct and activities', 'Every change recorded: who, when, what'] },
    { key: 'admissions', as: 'admin', path: '/admissions', section: 'Office & admissions', title: 'Admissions: from enquiry to enrolment', points: ['Enquiries with follow-ups and reminders', 'Online admission form and registration fee', 'Convert to a student without typing again'] },
    { key: 'attendance', as: 'teacher', path: '/attendance/mark', section: 'Classroom', title: 'Attendance in seconds', points: ['Class teacher marks the class on a phone', 'Parents are told at once when a child is absent', 'Staff check-in with face and location, or biometric machines'] },
    { key: 'timetable', as: 'admin', path: '/timetable', section: 'Classroom', title: 'Timetable and substitutions', points: ['Automatic timetable from teachers, subjects and rules', 'Substitutes for absent teachers suggested', 'Everyone sees their own timetable'] },
    { key: 'exams-marks', as: 'admin', path: '/exams/marks', section: 'Classroom', title: 'Exams and marks entry', points: ['Teachers enter marks for their subjects only', 'CBSE grading, co-scholastic areas, grace rules', 'Admit cards, seating plans and question papers'] },
    { key: 'exams-results', as: 'admin', path: '/exams/results', section: 'Classroom', title: 'Results and report cards', points: ['Report cards for a whole section in one PDF', 'Ranks, toppers and subject analysis', 'Parents see results the moment they are published'] },
    { key: 'homework', as: 'teacher', path: '/homework', section: 'Classroom', title: 'Homework', points: ['Teachers give homework with files', 'Parents and students see it on their phone', 'Checking and pending homework at a glance'] },
    { key: 'learn', as: 'student', path: '/learn', section: 'Classroom', title: 'AI learning and online tests', points: ['Subject → chapter → ask the AI tutor or take a quiz', 'Question bank with AI-written questions, approved by teachers', 'Online tests marked automatically'] },
    { key: 'fees-collect', as: 'admin', path: '/fees/collect?student=:student', section: 'Fees & finance', title: 'Fee collection at the counter', points: ['Find a student, see dues, take payment, print the receipt', 'Cash, UPI, cheque; online payment through Razorpay', 'Concessions, late fines and instalments by rule'] },
    { key: 'fees-dues', as: 'admin', path: '/fees/dues', section: 'Fees & finance', title: 'Dues and reminders', points: ['Who owes what, by class and instalment', 'Reminders to parents by app, email or SMS', 'Daily collection and head-wise reports'] },
    { key: 'payroll', as: 'admin', path: '/payroll', section: 'Fees & finance', title: 'Payroll', points: ['Salary structures, PF, ESI, TDS and loans', 'Payslips for every staff member', 'Attendance and leave flow into salaries'] },
    { key: 'accounts', as: 'admin', path: '/accounts', section: 'Fees & finance', title: 'Accounts', points: ['Vouchers, day book, ledgers and bank', 'Fee receipts posted by themselves', 'Trial balance, income & expenditure, balance sheet'] },
    { key: 'transport', as: 'admin', path: '/transport', section: 'Campus life', title: 'Transport with live tracking', points: ['Routes, stops, buses, drivers and fares', 'Live bus location for the office and parents', 'Students marked on and off the bus'] },
    { key: 'hostel', as: 'admin', path: '/hostel', section: 'Campus life', title: 'Hostel and mess', points: ['Rooms, roll call, leave passes and the sick bay', 'Mess plans, menu, head count and counter', 'Wardens work from their phones'] },
    { key: 'library', as: 'admin', path: '/library', section: 'Campus life', title: 'Library', points: ['Books, barcodes, issue and return', 'Fines and reservations', 'Students see their books and due dates'] },
    { key: 'houses', as: 'admin', path: '/houses', section: 'Campus life', title: 'Houses', points: ['Live house standings and points', 'Balanced house allocation in one click', 'House masters, captains and prefects'] },
    { key: 'competitions', as: 'admin', path: '/competitions?open=:competition', section: 'Campus life', title: 'Competitions and clubs', points: ['Inter-house results add house points by themselves', 'Merit and participation certificates printed in bulk', 'Clubs with members, meetings, attendance and photos'] },
    { key: 'visitors', as: 'admin', path: '/visitors', section: 'Campus life', title: 'Gate: visitors and pickups', points: ['Visitor passes with photo and QR', 'Early pickups only by authorised people', 'Parents told when their child leaves'] },
    { key: 'discipline', as: 'admin', path: '/discipline', section: 'Campus life', title: 'Discipline and complaints', points: ['Incidents, actions and approvals', 'Positive notes and conduct points', 'Complaints from parents and staff tracked to closure'] },
    { key: 'inventory', as: 'admin', path: '/inventory', section: 'Campus life', title: 'Store, assets and ID cards', points: ['Store stock, purchase, issue and sales', 'Asset register, repairs and verification', 'ID cards designed and printed with QR'] },
    { key: 'parent-home', as: 'parent', path: '/home', section: 'Parents & students', title: 'The parent’s home', points: ['Everything about their child in one place', 'Attendance, homework, fees, results, bus', 'Notices and alerts instead of WhatsApp groups'] },
    { key: 'parent-fees', as: 'parent', path: '/my-fees', section: 'Parents & students', title: 'Fees for parents', points: ['Dues, receipts and history', 'Pay online by UPI or card', 'Receipt arrives instantly'] },
    { key: 'parent-activities', as: 'parent', path: '/my-activities', section: 'Parents & students', title: 'Activities for families', points: ['House, clubs, competition results and achievements', 'Ask to join a club', 'House standings of the school'] },
    { key: 'parent-mobile', as: 'mobile', path: '/home', section: 'Parents & students', title: 'On the phone', points: ['Works on every phone, no app download needed', 'Android and iPhone apps next', 'Hindi website for parents'] },
    { key: 'reports', as: 'admin', path: '/reports', section: 'Control & insight', title: 'Report Center', points: ['Ready reports for every module', 'PDF, Excel and Word; the school’s own designs', 'Report Builder: make new reports by choosing fields'] },
    { key: 'assistant', as: 'admin', path: '/assistant', section: 'Control & insight', title: 'AI Assistant', points: ['Ask in plain words: “Who has fees due in Class 8?”', 'Answers only from what the person may see', 'Charts and lists in the chat'] },
    { key: 'alerts', as: 'admin', path: '/alerts', section: 'Control & insight', title: 'Alerts and messages', points: ['Built-in alerts for absence, fees, results, bus…', 'App, email, SMS and WhatsApp', 'Custom alerts from any report'] },
    { key: 'roles', as: 'admin', path: '/roles', section: 'Control & insight', title: 'Roles and permissions', points: ['Every action is a permission', 'Teachers see only their own classes', 'Add roles to match the school'] },
    { key: 'masters', as: 'admin', path: '/masters', section: 'Control & insight', title: 'Everything is configurable', points: ['System Settings for every rule, with sensible defaults', 'Masters for every list in the forms', 'Menu, documents and dashboards set up by the school'] },
];

const PROBLEMS: [string, string][] = [
    ['Registers and Excel sheets', 'Attendance, fees and marks live on paper and in many Excel files that never match.'],
    ['Fee leakage and dues', 'Hard to know who has paid; receipts written by hand; reminders forgotten.'],
    ['Parents in the dark', 'News reaches parents late, through WhatsApp groups that nobody can search.'],
    ['Report cards take weeks', 'Teachers add up marks by hand; mistakes and late results.'],
    ['Too many separate apps', 'One app for fees, another for transport, another for the library — none talk to each other.'],
    ['No picture for the principal', 'Numbers come only when someone prepares them; problems are seen too late.'],
    ['Data not safe', 'Records on one office computer or in personal phones; no backup, no control over who sees what.'],
    ['Office overloaded', 'Certificates, TCs, ID cards and letters typed again and again.'],
];

const SOLUTIONS: [string, string][] = [
    ['Paper registers, Excel', 'One database: attendance, fees, marks, everything entered once'],
    ['Fee leakage', 'Receipts by the system, online payment, automatic dues and reminders'],
    ['Parents uninformed', 'Instant alerts and a parent login for each family'],
    ['Late report cards', 'Marks entered by teachers, report cards printed in one click'],
    ['Many separate apps', '30+ modules in one ERP with one login'],
    ['No overview', 'Live dashboards, 100+ reports and an AI assistant'],
    ['Unsafe data', 'Roles and permissions, audit log, nightly backups, data in India'],
    ['Repetitive office work', 'Certificates, TCs, ID cards and letters from templates'],
];

const MODULES = ['Students', 'Admissions', 'Attendance', 'Timetable', 'Exams & results', 'Homework', 'AI learning', 'Online tests', 'Fees', 'Online payment', 'Payroll', 'Accounts', 'Transport & GPS', 'Hostel', 'Mess', 'Library', 'Inventory', 'Assets', 'ID cards', 'Visitors', 'Discipline', 'Complaints', 'Houses & clubs', 'Competitions', 'PTM', 'Notices & calendar', 'Alerts & messages', 'Staff & leave', 'Reports', 'AI assistant'];

const ROLES: [string, string][] = [
    ['Management & principal', 'Dashboards, approvals, reports, AI assistant'],
    ['Office & accountant', 'Admissions, fees, certificates, payroll, accounts'],
    ['Teachers', 'Attendance, homework, marks, timetable, clubs'],
    ['Parents', 'Fees, attendance, results, bus, notices on the phone'],
    ['Students', 'Homework, tests, AI tutor, timetable, results'],
    ['Wardens, drivers, guards', 'Hostel roll call, bus trips, gate passes'],
];

const NAVY = '1A365D';
const GOLD = 'C9A227';
const GREY = '5B6575';

const imageOf = (key: string) => {
    const p = path.join(ASSETS, 'demo-deck', `${key}.jpg`);
    return fs.existsSync(p) ? `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` : null;
};
const logo = () => {
    const p = path.join(ASSETS, 'logo.png');
    return fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : null;
};

/** The deck as a .pptx file. */
export const buildDemoDeck = async (): Promise<Buffer> => {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in
    pptx.company = COMPANY;
    pptx.title = `${PRODUCT}: demo`;
    const L = logo();
    pptx.defineSlideMaster({
        title: 'PAGE',
        background: { color: 'FFFFFF' },
        objects: [
            { rect: { x: 0, y: 7.2, w: 13.33, h: 0.3, fill: { color: NAVY } } },
            { text: { text: `${PRODUCT} · ${COMPANY}`, options: { x: 0.4, y: 7.2, w: 8, h: 0.3, fontSize: 9, color: 'FFFFFF' } } },
        ],
        slideNumber: { x: 12.4, y: 7.22, w: 0.6, h: 0.26, fontSize: 9, color: 'FFFFFF' },
    });
    const heading = (s: PptxGenJS.Slide, text: string, sub?: string) => {
        s.addText(text, { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontSize: 28, bold: true, color: NAVY });
        if (sub) s.addText(sub, { x: 0.5, y: 0.95, w: 12.3, h: 0.4, fontSize: 14, color: GREY });
        s.addShape(pptx.ShapeType.rect, { x: 0.5, y: sub ? 1.4 : 1.05, w: 1.2, h: 0.06, fill: { color: GOLD }, line: { color: GOLD } });
    };

    // 1. Title.
    const t = pptx.addSlide();
    t.background = { color: NAVY };
    if (L) {
        t.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 0.6, w: 1.6, h: 1.6, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' }, rectRadius: 0.15 });
        t.addImage({ data: L, x: 0.7, y: 0.7, w: 1.4, h: 1.4 });
    }
    t.addText(PRODUCT, { x: 0.7, y: 2.5, w: 12, h: 1, fontSize: 44, bold: true, color: 'FFFFFF' });
    t.addText('One system for the whole school: office, classroom, campus and parents.', { x: 0.7, y: 3.5, w: 11.5, h: 0.7, fontSize: 20, color: 'E2E8F0' });
    t.addShape(pptx.ShapeType.rect, { x: 0.7, y: 4.4, w: 1.6, h: 0.07, fill: { color: GOLD }, line: { color: GOLD } });
    t.addText(`${COMPANY}  ·  ${CONTACT.phone}  ·  ${CONTACT.email}`, { x: 0.7, y: 6.4, w: 12, h: 0.4, fontSize: 13, color: 'CBD5E1' });

    // 2. The problem.
    const p = pptx.addSlide({ masterName: 'PAGE' });
    heading(p, 'Before: how most schools run today', 'The problems we hear in every school');
    PROBLEMS.forEach(([h, d], i) => {
        const x = 0.5 + (i % 2) * 6.25;
        const y = 1.75 + Math.floor(i / 2) * 1.32;
        p.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.0, h: 1.15, fill: { color: 'FFF7ED' }, line: { color: 'FED7AA' }, rectRadius: 0.08 });
        p.addText([{ text: `✗  ${h}\n`, options: { bold: true, color: 'B45309', fontSize: 15 } }, { text: d, options: { color: '374151', fontSize: 12 } }], { x: x + 0.2, y: y + 0.08, w: 5.6, h: 1.0, valign: 'top' });
    });

    // 3. What we are building.
    const b = pptx.addSlide({ masterName: 'PAGE' });
    heading(b, 'What we are building', `${PRODUCT}: ${MODULES.length}+ modules, one login, every role, on any device`);
    MODULES.forEach((m, i) => {
        const x = 0.5 + (i % 6) * 2.07;
        const y = 1.75 + Math.floor(i / 6) * 1.0;
        b.addShape(pptx.ShapeType.roundRect, { x, y, w: 1.92, h: 0.82, fill: { color: i % 2 ? 'EEF2F7' : 'E6ECF5' }, line: { color: 'C7D2E3' }, rectRadius: 0.08 });
        b.addText(m, { x, y, w: 1.92, h: 0.82, align: 'center', valign: 'middle', fontSize: 12, bold: true, color: NAVY });
    });

    // 4. What it resolves.
    const r = pptx.addSlide({ masterName: 'PAGE' });
    heading(r, 'What it resolves', 'Each everyday problem, and how the ERP takes it away');
    r.addTable(
        [
            [
                { text: 'The problem', options: { bold: true, color: 'FFFFFF', fill: { color: 'B45309' } } },
                { text: `With ${PRODUCT}`, options: { bold: true, color: 'FFFFFF', fill: { color: '15803D' } } },
            ],
            ...SOLUTIONS.map(([a, s], i) => [
                { text: a, options: { color: '7C2D12', fill: { color: i % 2 ? 'FFFFFF' : 'FFF7ED' } } },
                { text: `✓ ${s}`, options: { color: '14532D', fill: { color: i % 2 ? 'FFFFFF' : 'F0FDF4' } } },
            ]),
        ],
        { x: 0.5, y: 1.7, w: 12.3, colW: [4.3, 8.0], fontSize: 13, rowH: 0.52, border: { type: 'solid', color: 'E5E7EB', pt: 1 } }
    );

    // 5. Who uses it.
    const w = pptx.addSlide({ masterName: 'PAGE' });
    heading(w, 'Who uses it', 'Each person sees only what their role allows');
    ROLES.forEach(([h, d], i) => {
        const x = 0.5 + (i % 3) * 4.15;
        const y = 1.8 + Math.floor(i / 3) * 2.45;
        w.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 2.2, fill: { color: 'EEF2F7' }, line: { color: 'C7D2E3' }, rectRadius: 0.1 });
        w.addText(h, { x: x + 0.25, y: y + 0.25, w: 3.5, h: 0.6, fontSize: 17, bold: true, color: NAVY });
        w.addText(d, { x: x + 0.25, y: y + 0.9, w: 3.5, h: 1.1, fontSize: 13, color: '374151', valign: 'top' });
    });

    // 6. The screens, with a divider before each section.
    let section = '';
    for (const sc of DECK_SCREENS) {
        if (sc.section !== section) {
            section = sc.section;
            const d = pptx.addSlide();
            d.background = { color: NAVY };
            d.addText(section, { x: 0.8, y: 2.8, w: 11.5, h: 1, fontSize: 40, bold: true, color: 'FFFFFF' });
            d.addText(DECK_SCREENS.filter((x) => x.section === section).map((x) => x.title).join('  ·  '), { x: 0.8, y: 3.9, w: 11.5, h: 1.2, fontSize: 15, color: 'CBD5E1', valign: 'top' });
            d.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.75, w: 1.4, h: 0.06, fill: { color: GOLD }, line: { color: GOLD } });
        }
        const s = pptx.addSlide({ masterName: 'PAGE' });
        heading(s, sc.title);
        const img = imageOf(sc.key);
        const phone = sc.as === 'mobile';
        // The screen (1440 × 900 = 16:10; a phone 390 × 844) with a thin frame.
        const box = phone ? { x: 1.2, y: 1.35, w: 2.66, h: 5.75 } : { x: 0.5, y: 1.35, w: 9.0, h: 5.62 };
        s.addShape(pptx.ShapeType.rect, { x: box.x - 0.04, y: box.y - 0.04, w: box.w + 0.08, h: box.h + 0.08, fill: { color: 'E5E7EB' }, line: { color: 'CBD5E1' } });
        if (img) s.addImage({ data: img, ...box });
        else s.addText('Screenshot: run npm run demo:screens', { ...box, align: 'center', valign: 'middle', color: GREY, fontSize: 14 });
        const tx = phone ? 4.6 : 9.8;
        s.addText(
            sc.points.map((pt) => ({ text: pt, options: { bullet: { code: '25CF' }, paraSpaceAfter: 14 } })),
            { x: tx, y: 1.5, w: 13.33 - tx - 0.4, h: 4.5, fontSize: 15, color: '1F2937', valign: 'top' }
        );
    }

    // Security, going live, thank you.
    const sec = pptx.addSlide({ masterName: 'PAGE' });
    heading(sec, 'Your data is safe', 'Built for schools that handle children’s records');
    [
        ['Each school’s data kept apart', 'Checked automatically: one school can never see another’s records'],
        ['Role-based access', 'Every screen and action is a permission; teachers see only their classes'],
        ['Audit log', 'Who changed what and when, for every record'],
        ['Backups every night', 'Data stored in India; a full export of the school’s data at any time'],
        ['Secure sign-in', 'Encrypted passwords, two-factor sign-in, sessions that expire'],
        ['Parents’ consent and DPDP', 'Data used only for the school; deletion on request'],
    ].forEach(([h, d], i) => {
        const x = 0.5 + (i % 2) * 6.25;
        const y = 1.75 + Math.floor(i / 2) * 1.7;
        sec.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.0, h: 1.5, fill: { color: 'F0FDF4' }, line: { color: 'BBF7D0' }, rectRadius: 0.08 });
        sec.addText([{ text: `✓  ${h}\n`, options: { bold: true, color: '15803D', fontSize: 16 } }, { text: d, options: { color: '374151', fontSize: 13 } }], { x: x + 0.2, y: y + 0.12, w: 5.6, h: 1.3, valign: 'top' });
    });

    const g = pptx.addSlide({ masterName: 'PAGE' });
    heading(g, 'Going live: four steps', 'Most schools are running within two to three weeks');
    [
        ['1', 'Share the details', 'School profile, classes, students and staff in our Excel templates, fee structure (see the Prerequisites PDF)'],
        ['2', 'We set it up', 'We create the school, import the data, set fees, exams and templates, and check everything with you'],
        ['3', 'Training', 'Office, accounts and teachers trained on their own screens; parents get their logins'],
        ['4', 'Go live', 'Start with attendance and fees, then the rest; we stay with you on call and WhatsApp'],
    ].forEach(([n, h, d], i) => {
        const y = 1.75 + i * 1.3;
        g.addShape(pptx.ShapeType.ellipse, { x: 0.6, y, w: 0.9, h: 0.9, fill: { color: NAVY }, line: { color: NAVY } });
        g.addText(n, { x: 0.6, y, w: 0.9, h: 0.9, align: 'center', valign: 'middle', fontSize: 24, bold: true, color: 'FFFFFF' });
        g.addText([{ text: `${h}\n`, options: { bold: true, fontSize: 18, color: NAVY } }, { text: d, options: { fontSize: 14, color: '374151' } }], { x: 1.8, y: y - 0.05, w: 11, h: 1.05, valign: 'top' });
    });

    const e = pptx.addSlide();
    e.background = { color: NAVY };
    if (L) {
        e.addShape(pptx.ShapeType.roundRect, { x: 5.87, y: 0.9, w: 1.6, h: 1.6, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' }, rectRadius: 0.15 });
        e.addImage({ data: L, x: 5.97, y: 1.0, w: 1.4, h: 1.4 });
    }
    e.addText('Thank you', { x: 0, y: 2.7, w: 13.33, h: 1, align: 'center', fontSize: 44, bold: true, color: 'FFFFFF' });
    e.addText('Book a free demo for your school', { x: 0, y: 3.7, w: 13.33, h: 0.6, align: 'center', fontSize: 20, color: 'E2E8F0' });
    e.addText(`${CONTACT.phone}   ·   ${CONTACT.email}`, { x: 0, y: 4.6, w: 13.33, h: 0.5, align: 'center', fontSize: 18, bold: true, color: GOLD });
    e.addText(COMPANY, { x: 0, y: 6.4, w: 13.33, h: 0.4, align: 'center', fontSize: 13, color: 'CBD5E1' });

    return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
};
