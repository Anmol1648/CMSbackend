import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, forbidden } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { defineDocument } from '../documents/documents.registry';
import { getSettings } from '../../core/settings';
import { assertMine, computeResults, resolveScope, ScopeKind, viewableSections } from './results.service';
import { gradeOf } from './setup.service';
import { EXAMS } from './exams.settings';

/** The report card (Document Templates): one student, or a whole section in one PDF (a page each). */

const uuid = (v: string | undefined, what: string) => {
    if (!v || !z.uuid().safeParse(v).success) throw badRequest(`Choose the ${what}`);
    return v;
};
const gradesOnly = async () => (await getSettings({ shows: EXAMS.reportCardShows })).shows === 'grades_only';
const num = (n: number | null) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The cards of a result, shaped for the template (each cell already written out). */
const cardsOf = (r: Awaited<ReturnType<typeof computeResults>>, gradesOnly = false) =>
    r.students.map((s) => ({
        student: { ...s.student, section: r.section.label, className: r.section.className },
        year: r.year,
        title: r.scope.label,
        classTeacher: r.section.classTeacher ?? '',
        descriptive: r.rule.descriptive || gradesOnly,
        examHeads: r.exams.map((e) => ({ name: e.shortName, weightage: e.weightage })),
        rows: s.subjects.map((sub) => ({
            subject: sub.subject,
            cells: r.exams.map((e) => {
                const x = sub.exams.find((y) => y.examId === e.id);
                if (!x) return { text: '—' };
                if (r.rule.descriptive) return { text: x.grade ?? '—' };
                if (gradesOnly && x.status === 'P') return { text: x.obtained != null && x.max ? (gradeOf(r.rule.bands, (x.obtained / x.max) * 100)?.grade ?? '—') : '—' };
                // Absent, medical… show their short form (Masters → Mark statuses).
                if (x.status !== 'P' && x.status !== 'none') return { text: x.status };
                return { text: x.obtained == null ? '—' : `${num(x.obtained)}/${x.max}` };
            }),
            percent: sub.percent == null ? '—' : `${num(sub.percent)}%`,
            grade: sub.grade ?? '—',
            failed: sub.passed === false,
            grace: sub.grace ? `+${sub.grace}` : '',
        })),
        total: s.totalMax && !gradesOnly ? `${num(s.totalObtained)} / ${s.totalMax}` : null,
        percent: s.percent == null || gradesOnly ? null : `${num(s.percent)}%`,
        grade: s.grade,
        rank: s.rank,
        result: s.result ?? 'Result not ready',
        failedSubjects: s.failedSubjects.join(', '),
        graced: s.graced.join(', '),
        promotedTo: s.promotedTo,
        co: s.co,
        discipline: s.discipline,
        remark: s.remark,
        attendance: s.attendance ? `${num(s.attendance.present)} / ${s.attendance.days}${s.attendance.percent != null ? ` (${num(s.attendance.percent)}%)` : ''}` : null,
        gradeKey: r.rule.descriptive ? r.rule.bands.map((b) => b.grade).join(' · ') : r.rule.bands.map((b) => `${b.grade} ${b.min}+`).join(' · '),
    }));

const HTML = `<header class="head">
  {{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}
  <div>
    <h1>{{school.name}}</h1>
    <p>{{school.address}}</p>
    {{#if school.affiliationNo}}<p>Affiliation no. {{school.affiliationNo}}{{#if school.udiseCode}} · UDISE {{school.udiseCode}}{{/if}}</p>{{/if}}
  </div>
</header>
<h2 class="title">REPORT CARD · {{upper title}} · {{year}}</h2>
<table class="info">
  <tr><td>Name</td><td><b>{{student.name}}</b></td><td>Class / Section</td><td><b>{{student.section}}</b></td></tr>
  <tr><td>Admission no.</td><td>{{student.admissionNo}}</td><td>Roll no.</td><td>{{student.roll}}</td></tr>
  <tr><td>Father</td><td>{{student.father}}</td><td>Mother</td><td>{{student.mother}}</td></tr>
  <tr><td>Date of birth</td><td>{{date student.dateOfBirth}}</td><td>Attendance</td><td>{{attendance}}</td></tr>
</table>
<h3>Scholastic areas</h3>
<table class="marks">
  <thead><tr><th class="l">Subject</th>{{#each examHeads}}<th>{{name}}{{#if weightage}}<small> ({{weightage}}%)</small>{{/if}}</th>{{/each}}{{#unless descriptive}}<th>%</th>{{/unless}}<th>Grade</th></tr></thead>
  <tbody>
  {{#each rows}}<tr{{#if failed}} class="fail"{{/if}}><td class="l">{{subject}}</td>{{#each cells}}<td>{{text}}</td>{{/each}}{{#unless ../descriptive}}<td>{{percent}}{{#if grace}} <small>{{grace}}</small>{{/if}}</td>{{/unless}}<td><b>{{grade}}</b></td></tr>{{/each}}
  {{#unless descriptive}}<tr class="sum"><td class="l">Overall</td><td colspan="{{examHeads.length}}">{{#if total}}{{total}}{{/if}}</td><td>{{percent}}</td><td>{{grade}}</td></tr>{{/unless}}
  </tbody>
</table>
{{#if co.length}}
<h3>Co-scholastic areas</h3>
<table class="marks co"><tbody>{{#each co}}<tr><td class="l">{{area}}</td><td><b>{{#if grade}}{{grade}}{{else}}—{{/if}}</b></td></tr>{{/each}}{{#if discipline}}<tr><td class="l">Discipline</td><td><b>{{discipline}}</b></td></tr>{{/if}}</tbody></table>
{{/if}}
<div class="result">
  <p><b>Result:</b> {{result}}{{#if failedSubjects}} ({{failedSubjects}}){{/if}}{{#if rank}} · <b>Rank:</b> {{rank}}{{/if}}{{#if graced}} · Grace: {{graced}}{{/if}}</p>
  {{#if promotedTo}}<p><b>Promoted to:</b> {{promotedTo}}</p>{{/if}}
  {{#if remark}}<p><b>Class teacher’s remarks:</b> {{remark}}</p>{{/if}}
</div>
<p class="key">Grades: {{gradeKey}}</p>
<div class="sign"><div>Class teacher<br><small>{{classTeacher}}</small></div><div>Principal</div><div>Parent</div></div>`;

const CSS = `body { font-size: 11.5px; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 2px solid #1A365D; padding-bottom: 6px; }
.head .logo { width: 58px; height: 58px; object-fit: contain; }
.head h1 { margin: 0; font-size: 18px; color: #1A365D; text-transform: uppercase; }
.head p { margin: 1px 0; font-size: 10px; color: #333; }
h2.title { text-align: center; font-size: 14px; color: #1A365D; letter-spacing: 1px; margin: 10px 0; }
h3 { font-size: 12px; color: #1A365D; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 1px; }
table { width: 100%; border-collapse: collapse; }
table.info td { padding: 3px 6px; border: 1px solid #ccc; }
table.info td:nth-child(odd) { color: #555; width: 18%; }
table.marks th, table.marks td { border: 1px solid #999; padding: 4px 5px; text-align: center; }
table.marks th { background: #1A365D; color: #fff; font-size: 10.5px; }
table.marks td.l, table.marks th.l { text-align: left; }
table.marks tr.fail td { color: #c53030; }
table.marks tr.sum td { font-weight: 700; background: #EEF2F7; }
table.co { width: 55%; }
.result { margin-top: 10px; line-height: 1.6; }
.key { font-size: 9px; color: #666; margin-top: 6px; }
.sign { display: flex; justify-content: space-between; margin-top: 46px; font-size: 11px; }
.sign div { text-align: center; min-width: 120px; border-top: 1px solid #333; padding-top: 4px; }`;

defineDocument({
    key: 'report_card',
    label: 'Report card',
    description: 'A student’s marks and grades for an exam, a term or the session, with co-scholastic grades, attendance, remarks and result. A whole section prints as one PDF.',
    fields: [
        { key: 'title / year', label: 'Which result (“Half-Yearly”, “Term 1”, “Final result”) and the session' },
        { key: 'student.name / admissionNo / roll / section / father / mother / dateOfBirth', label: 'Student' },
        { key: '#each examHeads → name, weightage', label: 'Columns: the exams' },
        { key: '#each rows → subject, #each cells → text, percent, grade, failed, grace', label: 'Rows: the subjects' },
        { key: 'total / percent / grade / rank / result / failedSubjects / graced / promotedTo', label: 'Overall' },
        { key: '#each co → area, grade · discipline · remark · attendance', label: 'Co-scholastic, discipline, remarks, attendance' },
        { key: 'descriptive', label: 'Grades only (pre-primary)' },
        { key: 'gradeKey / classTeacher', label: 'The grading key, the class teacher' },
    ],
    html: HTML,
    css: CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 12, copies: ['Report card'] },
    sample: async () => {
        const e = await db.exam.findFirst({ where: { status: { in: ['published', 'locked', 'open'] } }, orderBy: { updatedAt: 'desc' } });
        const section = e ? await db.section.findFirst({ where: { academicYearId: e.academicYearId, classId: { in: e.classIds } }, select: { id: true } }) : null;
        if (!e || !section) throw badRequest('Set up an exam with marks first to preview the report card');
        const cards = cardsOf(await computeResults('exam', e.id, section.id), await gradesOnly());
        if (!cards.length) throw badRequest('That section has no students');
        return { data: cards[0], filename: 'report-card-sample.pdf' };
    },
    load: async (params, userId) => {
        const kind = (['exam', 'term', 'final'].includes(params.scope) ? params.scope : 'exam') as ScopeKind;
        const id = uuid(params.id, 'exam, term or session');
        const scope = await resolveScope(kind, id);
        const a = await getUserAccess(userId);
        if (params.student) {
            const studentId = uuid(params.student, 'student');
            const e = await db.enrolment.findFirst({ where: { studentId, academicYearId: scope.yearId }, select: { sectionId: true } });
            if (!e) throw badRequest('The student was not in this session');
            const allowed = a.permissions['exam.view'] ? await viewableSections(userId, scope.yearId) : [];
            if (allowed !== 'all' && !allowed.includes(e.sectionId)) {
                if (!a.permissions['exam.mine']) throw forbidden();
                await assertMine(userId, studentId, kind, id);
            }
            const [card] = cardsOf(await computeResults(kind, id, e.sectionId, studentId), await gradesOnly());
            if (!card) throw badRequest('No result for this student');
            return { data: card, filename: `report-card-${card.student.admissionNo.replace(/[^A-Za-z0-9]+/g, '-')}.pdf` };
        }
        const sectionId = uuid(params.section, 'section');
        const allowed = await viewableSections(userId, scope.yearId);
        if (!a.permissions['exam.view'] || (allowed !== 'all' && !allowed.includes(sectionId))) throw forbidden();
        const cards = cardsOf(await computeResults(kind, id, sectionId), await gradesOnly());
        if (!cards.length) throw badRequest('That section has no students');
        return { data: cards[0], many: cards, filename: `report-cards-${cards[0].student.section}.pdf` };
    },
});
