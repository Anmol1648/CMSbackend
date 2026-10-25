import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { defineDocument } from '../documents/documents.registry';
import { inWords } from '../documents/documents.service';
import { isoOf } from '../attendance/attendance.settings';
import { mayPrint } from './tc.service';
import { documentValues } from '../forms/forms.service';

/** The transfer certificate, and the bonafide and character certificates (Document Templates). */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth'];
/** 2012-03-23 → "Twenty Third March Two Thousand Twelve" (dates of birth in words, as on a TC). */
const dateInWords = (iso: string | null) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const day = d <= 20 ? ORD[d] : d === 30 ? 'Thirtieth' : d === 31 ? 'Thirty First' : `Twenty ${ORD[d - 20]}`;
    return `${day} ${MONTHS[m - 1]} ${inWords(y)}`;
};
const uuid = (v: string | undefined, what: string) => {
    if (!v || !z.uuid().safeParse(v).success) throw badRequest(`Choose the ${what}`);
    return v;
};

/** Everything certificates say about a student. */
const studentDetails = async (studentId: string) => {
    const s = await db.student.findFirst({
        where: { id: studentId },
        select: {
            id: true,
            firstName: true,
            middleName: true,
            lastName: true,
            admissionNo: true,
            admissionDate: true,
            dateOfBirth: true,
            status: true,
            statusDate: true,
            customFields: true,
            gender: { select: { name: true } },
            nationality: { select: { name: true } },
            casteCategory: { select: { name: true } },
            family: { select: { guardians: { select: { name: true, relation: { select: { name: true } } } } } },
            enrolments: { orderBy: { academicYear: { startDate: 'asc' } }, select: { academicYear: { select: { name: true } }, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } },
        },
    });
    if (!s) throw notFound('Student not found');
    const g = s.family?.guardians ?? [];
    const named = (re: RegExp) => g.find((x) => x.relation && re.test(x.relation.name))?.name ?? '';
    const first = s.enrolments[0];
    const last = s.enrolments[s.enrolments.length - 1];
    const year = await currentYear();
    const now = s.enrolments.find((e) => e.academicYear.name === year?.name) ?? last;
    const girl = /female|girl/i.test(s.gender?.name ?? '');
    return {
        name: fullName(s),
        admissionNo: s.admissionNo,
        admissionDate: isoOf(s.admissionDate),
        admissionClass: first?.section.schoolClass.name ?? '',
        dateOfBirth: s.dateOfBirth ? isoOf(s.dateOfBirth) : '',
        dateOfBirthWords: dateInWords(s.dateOfBirth ? isoOf(s.dateOfBirth) : null),
        gender: s.gender?.name ?? '',
        nationality: s.nationality?.name ?? 'Indian',
        category: s.casteCategory?.name ?? '',
        father: named(/father/i),
        mother: named(/mother/i),
        guardian: named(/father|mother/i) || g[0]?.name || '',
        /** "son" / "daughter", "He" / "She", "his" / "her". */
        child: girl ? 'daughter' : 'son',
        he: girl ? 'She' : 'He',
        his: girl ? 'her' : 'his',
        section: now ? sectionLabel(now.section) : '',
        className: now?.section.schoolClass.name ?? '',
        session: now?.academicYear.name ?? year?.name ?? '',
        status: s.status,
        /** The school's extra fields (Setup → Form Builder), as text: {{student.custom.<field key>}}. */
        custom: (await documentValues('student', [s])).get(s.id) ?? {},
    };
};

const FIELDS = [
    { key: 'student.name / admissionNo / admissionDate / admissionClass', label: 'Student and admission' },
    { key: 'student.dateOfBirth / dateOfBirthWords', label: 'Date of birth (and in words)' },
    { key: 'student.father / mother / guardian', label: 'Parents' },
    { key: 'student.gender / nationality / category', label: 'Gender, nationality, category' },
    { key: 'student.child / he / his', label: '“son” / “daughter”, “He” / “She”, “his” / “her”' },
    { key: 'student.className / section / session', label: 'Class, section and session now' },
    { key: 'student.custom.<field key>', label: 'An extra field of the school (Setup → Form Builder; the key is shown there)' },
];

const HEAD = `<header class="head">
  {{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}
  <div>
    <h1>{{school.name}}</h1>
    <p>{{school.address}}</p>
    <p>{{#if school.phone}}Ph: {{school.phone}}{{/if}}{{#if school.email}} · {{school.email}}{{/if}}</p>
    {{#if school.affiliationNo}}<p>Affiliation no. {{school.affiliationNo}}{{#if school.udiseCode}} · UDISE {{school.udiseCode}}{{/if}}</p>{{/if}}
  </div>
</header>`;
const CSS = `body { font-size: 12px; }
.head { display: flex; gap: 14px; align-items: center; border-bottom: 2px solid #1A365D; padding-bottom: 8px; }
.head .logo { width: 64px; height: 64px; object-fit: contain; }
.head h1 { margin: 0; font-size: 19px; color: #1A365D; text-transform: uppercase; }
.head p { margin: 1px 0; font-size: 10.5px; color: #333; }
h2.title { text-align: center; letter-spacing: 3px; margin: 14px 0 4px; font-size: 16px; color: #1A365D; }
.meta { display: flex; justify-content: space-between; font-size: 11px; margin: 6px 0 10px; }
.dup { text-align: center; color: #c53030; font-weight: 700; letter-spacing: 2px; }
table.tc { width: 100%; border-collapse: collapse; }
table.tc td { border: 1px solid #999; padding: 5px 7px; vertical-align: top; }
table.tc td.n { width: 26px; text-align: center; }
table.tc td.k { width: 48%; }
p.body { font-size: 13px; line-height: 1.9; text-align: justify; margin: 24px 0; }
.sign { display: flex; justify-content: space-between; margin-top: 60px; font-size: 11px; }
.sign div { text-align: center; min-width: 140px; border-top: 1px solid #333; padding-top: 4px; }`;

// ─── Transfer certificate ────────────────────────────────────────────────────

const TC_HTML = `${HEAD}
<h2 class="title">TRANSFER CERTIFICATE</h2>
{{#if duplicate}}<p class="dup">DUPLICATE</p>{{/if}}
<div class="meta"><span>TC No.: <b>{{tc.tcNo}}</b></span><span>Admission No.: <b>{{student.admissionNo}}</b></span></div>
<table class="tc">
  <tr><td class="n">1</td><td class="k">Name of the student</td><td><b>{{upper student.name}}</b></td></tr>
  <tr><td class="n">2</td><td class="k">Father’s name</td><td>{{student.father}}</td></tr>
  <tr><td class="n">3</td><td class="k">Mother’s name</td><td>{{student.mother}}</td></tr>
  <tr><td class="n">4</td><td class="k">Nationality</td><td>{{student.nationality}}</td></tr>
  <tr><td class="n">5</td><td class="k">Category (SC / ST / OBC / General)</td><td>{{student.category}}</td></tr>
  <tr><td class="n">6</td><td class="k">Date of birth (in figures and words)</td><td>{{date student.dateOfBirth}}<br>{{student.dateOfBirthWords}}</td></tr>
  <tr><td class="n">7</td><td class="k">Date of admission, with class</td><td>{{date student.admissionDate}}, {{student.admissionClass}}</td></tr>
  <tr><td class="n">8</td><td class="k">Class in which the student last studied</td><td>{{tc.lastClass}}</td></tr>
  <tr><td class="n">9</td><td class="k">Result of the last examination</td><td>{{tc.result}}</td></tr>
  <tr><td class="n">10</td><td class="k">Whether all dues to the school have been paid</td><td>{{#if feesClear}}Yes{{else}}No{{/if}}</td></tr>
  <tr><td class="n">11</td><td class="k">General conduct</td><td>{{tc.conduct}}</td></tr>
  <tr><td class="n">12</td><td class="k">Date of application for the certificate</td><td>{{date tc.applicationDate}}</td></tr>
  <tr><td class="n">13</td><td class="k">Date the student left the school</td><td>{{date tc.leavingDate}}</td></tr>
  <tr><td class="n">14</td><td class="k">Reason for leaving</td><td>{{tc.reason}}</td></tr>
  <tr><td class="n">15</td><td class="k">Date of issue of the certificate</td><td>{{date tc.issueDate}}</td></tr>
  <tr><td class="n">16</td><td class="k">Any other remarks</td><td>{{tc.remarks}}</td></tr>
</table>
<div class="sign"><div>Prepared by</div><div>Checked by</div><div>Principal<br>(with seal)</div></div>`;

const tcData = async (id: string, countPrint: boolean) => {
    const t = await db.transferCertificate.findFirst({ where: { id } });
    if (!t) throw notFound('TC not found');
    if (t.status !== 'issued') throw badRequest('The TC is printed once it is issued');
    if (countPrint) await db.transferCertificate.update({ where: { id }, data: { printCount: { increment: 1 } } });
    const reason = t.reasonId ? (await db.masterValue.findUnique({ where: { id: t.reasonId }, select: { name: true } }))?.name : null;
    const student = await studentDetails(t.studentId);
    return {
        data: {
            student,
            tc: { tcNo: t.tcNo, lastClass: t.lastClass ?? student.className, result: t.result ?? '', conduct: t.conduct, applicationDate: isoOf(t.applicationDate), leavingDate: isoOf(t.leavingDate), reason: reason ?? '', remarks: t.remarks ?? '', issueDate: t.issuedAt ? t.issuedAt.toISOString().slice(0, 10) : '' },
            duplicate: t.printCount > 0,
            feesClear: true,
        },
        filename: `TC-${(t.tcNo ?? 'draft').replace(/[^A-Za-z0-9]+/g, '-')}.pdf`,
    };
};

defineDocument({
    key: 'transfer_certificate',
    label: 'Transfer certificate',
    description: 'The TC of a student who leaves: printed once issued (later prints say DUPLICATE).',
    fields: [{ key: 'tc.tcNo / lastClass / result / conduct / applicationDate / leavingDate / reason / remarks / issueDate', label: 'The TC' }, { key: 'duplicate', label: 'A reprint (true / false)' }, ...FIELDS],
    html: TC_HTML,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 14, copies: ['Original'] },
    sample: async () => {
        const any = await db.transferCertificate.findFirst({ where: { status: 'issued' }, select: { id: true } });
        if (any) return tcData(any.id, false);
        const s = await db.student.findFirst({ where: { status: 'active' }, select: { id: true } });
        const student = s ? await studentDetails(s.id) : { name: 'Aarav Sharma', admissionNo: '2026/0001', father: 'Rajesh Sharma', mother: 'Sunita Sharma' };
        return {
            data: { student, tc: { tcNo: 'TC/2027/0001', lastClass: 'Class VII', result: 'Passed and promoted to Class VIII', conduct: 'Good', applicationDate: '2027-03-25', leavingDate: '2027-03-31', reason: 'Transfer of parent', remarks: '', issueDate: '2027-04-02' }, duplicate: false, feesClear: true },
            filename: 'tc-sample.pdf',
        };
    },
    load: async (params, userId) => {
        await mayPrint(userId, 'tc');
        return tcData(uuid(params.id, 'TC'), true);
    },
});

// ─── Bonafide and character certificates ─────────────────────────────────────

const BONAFIDE_HTML = `${HEAD}
<h2 class="title">BONAFIDE CERTIFICATE</h2>
<div class="meta"><span>Admission No.: <b>{{student.admissionNo}}</b></span><span>Date: {{date today}}</span></div>
<p class="body">This is to certify that <b>{{student.name}}</b>, {{student.child}} of <b>{{student.father}}</b>{{#if student.mother}} and <b>{{student.mother}}</b>{{/if}}, is a bonafide student of this school, studying in <b>{{student.section}}</b> during the session <b>{{student.session}}</b>. {{student.he}} was admitted on {{date student.admissionDate}}, and {{student.his}} date of birth as per the school records is <b>{{date student.dateOfBirth}}</b> ({{student.dateOfBirthWords}}).</p>
{{#if purpose}}<p class="body">This certificate is issued for the purpose of {{purpose}}.</p>{{/if}}
<div class="sign"><div>Class teacher</div><div>Principal<br>(with seal)</div></div>`;

const CHARACTER_HTML = `${HEAD}
<h2 class="title">CHARACTER CERTIFICATE</h2>
<div class="meta"><span>Admission No.: <b>{{student.admissionNo}}</b></span><span>Date: {{date today}}</span></div>
<p class="body">This is to certify that <b>{{student.name}}</b>, {{student.child}} of <b>{{student.father}}</b>, {{#if (eq student.status "active")}}is a student of this school, studying in <b>{{student.section}}</b>{{else}}was a student of this school, last in <b>{{student.className}}</b>{{/if}}. To the best of my knowledge {{student.his}} character and conduct {{#if (eq student.status "active")}}are{{else}}were{{/if}} <b>{{conduct}}</b>. I wish {{student.his}} every success in life.</p>
<div class="sign"><div>Class teacher</div><div>Principal<br>(with seal)</div></div>`;

const certificate = (key: string, label: string, description: string, html: string) =>
    defineDocument({
        key,
        label,
        description,
        fields: [...FIELDS, { key: 'purpose', label: 'Purpose (bonafide, optional)' }, { key: 'conduct', label: 'Conduct (character)' }],
        html,
        css: CSS,
        paper: { size: 'A4', orientation: 'portrait', margin: 16, copies: ['Original'] },
        sample: async () => {
            const s = await db.student.findFirst({ where: { status: 'active' }, select: { id: true } });
            if (!s) throw notFound('Add a student first');
            return { data: { student: await studentDetails(s.id), purpose: 'a bank account', conduct: 'Good' }, filename: `${key}-sample.pdf` };
        },
        load: async (params, userId) => {
            await mayPrint(userId, 'certificate');
            const student = await studentDetails(uuid(params.student, 'student'));
            return { data: { student, purpose: (params.purpose ?? '').slice(0, 120), conduct: (params.conduct ?? 'Good').slice(0, 40) }, filename: `${key}-${student.admissionNo.replace(/[^A-Za-z0-9]+/g, '-')}.pdf` };
        },
    });

certificate('bonafide_certificate', 'Bonafide certificate', 'That a student studies in the school this session (for a bank, a scholarship, a passport…).', BONAFIDE_HTML);
certificate('character_certificate', 'Character certificate', 'The conduct of a student (now or after leaving).', CHARACTER_HTML);
