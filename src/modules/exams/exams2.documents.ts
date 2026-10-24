import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, forbidden } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { defineDocument } from '../documents/documents.registry';
import { assertMine, computeResults, resolveScope, ScopeKind, sectionLimits, seesInFull } from './results.service';
import { gradeOf, Part } from './setup.service';
import { admitCards, photoData, principalSignature, seating } from './hall.service';
import { paperDocument } from './papers.service';
import { healthFor } from './entry2.service';

/**
 * Exam documents (Document Templates, editable): admit cards, the door list and desk slips of each
 * exam room, the question paper (and its answer key), the progress card, and two more report card
 * designs (CBSE term-wise, pre-primary) chosen per class group in the result rules.
 */

const uuid = (v: string | undefined, what: string) => {
    if (!v || !z.uuid().safeParse(v).success) throw badRequest(`Choose the ${what}`);
    return v;
};
const need = async (userId: string, keys: string[]) => {
    const a = await getUserAccess(userId);
    if (!keys.some((k) => a.permissions[k])) throw forbidden();
};
const num = (n: number | null) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const HEAD = `<header class="head">{{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}<div><h1>{{school.name}}</h1><p>{{school.address}}</p>{{#if school.affiliationNo}}<p>Affiliation no. {{school.affiliationNo}}{{#if school.udiseCode}} · UDISE {{school.udiseCode}}{{/if}}</p>{{/if}}</div></header>`;
const BASE_CSS = `body { font-size: 11.5px; color: #111; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 2px solid #1A365D; padding-bottom: 6px; }
.head .logo { width: 56px; height: 56px; object-fit: contain; }
.head h1 { margin: 0; font-size: 18px; color: #1A365D; text-transform: uppercase; }
.head p { margin: 1px 0; font-size: 10.5px; }
h2.title { text-align: center; font-size: 14px; color: #1A365D; letter-spacing: 1px; margin: 10px 0; }
h3 { font-size: 12px; color: #1A365D; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 1px; }
table { width: 100%; border-collapse: collapse; }
table.grid th, table.grid td { border: 1px solid #999; padding: 4px 5px; text-align: center; }
table.grid th { background: #1A365D; color: #fff; font-size: 10.5px; }
table.grid td.l, table.grid th.l { text-align: left; }
table.info td { padding: 3px 6px; border: 1px solid #ccc; }
table.info td:nth-child(odd) { color: #555; width: 18%; }
.sign { display: flex; justify-content: space-between; margin-top: 40px; font-size: 11px; }
.sign div { text-align: center; min-width: 120px; border-top: 1px solid #333; padding-top: 4px; }
.sign img { display: block; height: 34px; margin: 0 auto -4px; }`;

// ─── Admit card ──────────────────────────────────────────────────────────────

const sampleExamSection = async () => {
    const e = await db.exam.findFirst({ where: { status: { not: 'draft' } }, orderBy: { updatedAt: 'desc' } });
    const section = e ? await db.section.findFirst({ where: { academicYearId: e.academicYearId, classId: { in: e.classIds } }, select: { id: true } }) : null;
    if (!e || !section) throw badRequest('Set up an exam first to preview');
    return { examId: e.id, sectionId: section.id };
};

defineDocument({
    key: 'admit_card',
    label: 'Admit card',
    description: 'A student’s hall ticket for an exam: photo, roll no., the date sheet with room and seat, instructions and the principal’s signature. A section prints as one PDF; cards held for fees are left out.',
    fields: [
        { key: 'exam / year', label: 'The exam and session' },
        { key: 'student.name / admissionNo / roll / section / father / dateOfBirth / photo', label: 'Student (photo as <img src="{{student.photo}}">)' },
        { key: '#each papers → subject, date, time, seat', label: 'The papers' },
        { key: '#each instructions', label: 'Instructions (System Settings → Exams)' },
        { key: 'signature', label: 'Principal’s signature (image)' },
    ],
    html: `${HEAD}
<h2 class="title">ADMIT CARD · {{upper exam}} · {{year}}</h2>
<div class="admit"><table class="info"><tr><td>Name</td><td><b>{{student.name}}</b></td><td>Class / Section</td><td><b>{{student.section}}</b></td></tr>
<tr><td>Admission no.</td><td>{{student.admissionNo}}</td><td>Roll no.</td><td><b>{{student.roll}}</b></td></tr>
<tr><td>Father</td><td>{{student.father}}</td><td>Date of birth</td><td>{{date student.dateOfBirth}}</td></tr></table>
{{#if student.photo}}<img class="photo" src="{{student.photo}}" alt="">{{else}}<div class="photo none">Photo</div>{{/if}}</div>
<h3>Date sheet</h3>
<table class="grid"><thead><tr><th class="l">Subject</th><th>Date</th><th>Time</th><th>Room / seat</th><th>Invigilator’s sign</th></tr></thead>
<tbody>{{#each papers}}<tr><td class="l">{{subject}}</td><td>{{date}}</td><td>{{time}}</td><td>{{seat}}</td><td></td></tr>{{/each}}</tbody></table>
<h3>Instructions</h3><ol class="instr">{{#each instructions}}<li>{{this}}</li>{{/each}}</ol>
<div class="sign"><div>Student’s signature</div><div>Class teacher</div><div>{{#if signature}}<img src="{{signature}}" alt="">{{/if}}Principal</div></div>`,
    css: `${BASE_CSS}
.admit { display: flex; gap: 12px; align-items: flex-start; }
.admit table { flex: 1; }
.photo { width: 90px; height: 112px; object-fit: cover; border: 1px solid #999; }
.photo.none { display: flex; align-items: center; justify-content: center; color: #999; font-size: 10px; }
.instr { margin: 4px 0 0 16px; padding: 0; line-height: 1.5; }`,
    paper: { size: 'A4', orientation: 'portrait', margin: 12, copies: ['Admit card'] },
    sample: async () => {
        const { examId, sectionId } = await sampleExamSection();
        const r = await admitCards(examId, sectionId);
        if (!r.cards.length) throw badRequest('That section has no admit cards to show');
        return { data: r.cards[0], filename: 'admit-card-sample.pdf' };
    },
    load: async (params, userId) => {
        await need(userId, ['exam.admit']);
        const r = await admitCards(uuid(params.exam, 'exam'), uuid(params.section, 'section'), params.student ? uuid(params.student, 'student') : undefined);
        if (!r.cards.length) throw badRequest(r.held ? 'Every admit card of this section is held for fees' : 'No admit cards to print');
        return { data: r.cards[0], many: r.cards, filename: `admit-cards-${r.cards[0].student.section}.pdf` };
    },
});

// ─── Exam room: door list and desk slips ─────────────────────────────────────

const roomPages = async (params: Record<string, string>) => {
    const s = await seating(uuid(params.exam, 'exam'), params.date ?? '', params.time ?? '');
    if (!s.rooms.length) throw badRequest('Make the seating plan of this paper first');
    const when = `${params.date ? new Date(`${params.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''}${params.time ? ` · ${params.time}` : ''}`;
    return s.rooms.map((r) => ({ exam: s.exam.name, when, room: r.room, count: r.seats.length, invigilators: r.invigilators.map((i) => i.name).join(', '), seats: r.seats }));
};
defineDocument({
    key: 'exam_room_list',
    label: 'Exam room door list',
    description: 'For each room of a paper: who sits where (seat, name, roll, class) and the invigilators. Stick on the door; also the attendance sheet.',
    fields: [
        { key: 'exam / when / room / count / invigilators', label: 'The room and paper' },
        { key: '#each seats → seatNo, name, admissionNo, roll, section', label: 'The seats' },
    ],
    html: `${HEAD}
<h2 class="title">{{upper exam}} · {{when}}</h2>
<p class="room"><b>Room: {{room}}</b> · {{count}} students{{#if invigilators}} · Invigilators: {{invigilators}}{{/if}}</p>
<table class="grid"><thead><tr><th>Seat</th><th class="l">Name</th><th>Class</th><th>Roll</th><th>Adm. no.</th><th>Answer sheet no.</th><th>Signature</th></tr></thead>
<tbody>{{#each seats}}<tr><td><b>{{seatNo}}</b></td><td class="l">{{name}}</td><td>{{section}}</td><td>{{roll}}</td><td>{{admissionNo}}</td><td></td><td></td></tr>{{/each}}</tbody></table>
<div class="sign"><div>Invigilator</div><div>Exam in-charge</div></div>`,
    css: `${BASE_CSS}\n.room { font-size: 13px; margin: 6px 0; }\ntable.grid td { padding: 5px; }`,
    paper: { size: 'A4', orientation: 'portrait', margin: 10, copies: ['Door list'] },
    sample: async () => ({ data: { exam: 'Half-Yearly', when: 'Mon, 21 Sep 2026 · 09:00', room: 'Room 101', count: 2, invigilators: 'Anita Sharma', seats: [{ seatNo: 1, name: 'Rohan Negi', section: 'VII-B', roll: 12, admissionNo: '2025/0102' }, { seatNo: 2, name: 'Priya Rawat', section: 'VIII-A', roll: 7, admissionNo: '2024/0333' }] }, filename: 'door-list-sample.pdf' }),
    load: async (params, userId) => {
        await need(userId, ['exam.seating', 'exam.admit']);
        const pages = await roomPages(params);
        return { data: pages[0], many: pages, filename: 'exam-room-lists.pdf' };
    },
});

defineDocument({
    key: 'exam_desk_slips',
    label: 'Exam desk slips',
    description: 'A slip for each desk of a room (seat no., name, class, roll) to stick on the desks.',
    fields: [{ key: 'room / exam / #each seats', label: 'The room and its seats' }],
    html: `<p class="top"><b>{{room}}</b> · {{exam}} · {{when}}</p>
<div class="slips">{{#each seats}}<div class="slip"><div class="no">{{seatNo}}</div><div><b>{{name}}</b><br>{{section}} · Roll {{roll}}<br><small>{{admissionNo}}</small></div></div>{{/each}}</div>`,
    css: `body { font-size: 11px; }
.top { margin: 0 0 6px; }
.slips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.slip { border: 1px dashed #555; padding: 8px; display: flex; gap: 8px; align-items: center; break-inside: avoid; }
.slip .no { font-size: 26px; font-weight: 800; color: #1A365D; min-width: 36px; text-align: center; }`,
    paper: { size: 'A4', orientation: 'portrait', margin: 8, copies: ['Desk slips'] },
    sample: async () => ({ data: { room: 'Room 101', exam: 'Half-Yearly', when: '21 Sep', seats: [{ seatNo: 1, name: 'Rohan Negi', section: 'VII-B', roll: 12, admissionNo: '2025/0102' }] }, filename: 'desk-slips-sample.pdf' }),
    load: async (params, userId) => {
        await need(userId, ['exam.seating', 'exam.admit']);
        const pages = await roomPages(params);
        return { data: pages[0], many: pages, filename: 'desk-slips.pdf' };
    },
});

// ─── Question paper ──────────────────────────────────────────────────────────

defineDocument({
    key: 'question_paper',
    label: 'Question paper',
    description: 'An exam paper built from the question bank (sections, marks against each question). With “answer key”, the answers are printed under each question.',
    fields: [
        { key: 'title / className / subject / exam / date / duration / max', label: 'The paper' },
        { key: '#each instructions', label: 'General instructions' },
        { key: '#each sections → name, marks, #each questions → no, text, marks, #each options, answer', label: 'Sections and questions' },
        { key: 'withKey', label: 'Printing the answer key' },
    ],
    html: `${HEAD}
<h2 class="title">{{upper title}}{{#if withKey}} · ANSWER KEY{{/if}}</h2>
<table class="info"><tr><td>Class</td><td><b>{{className}}</b></td><td>Subject</td><td><b>{{subject}}</b></td></tr><tr><td>Time</td><td>{{duration}}</td><td>Maximum marks</td><td><b>{{max}}</b></td></tr></table>
{{#if instructions.length}}<h3>General instructions</h3><ol class="instr">{{#each instructions}}<li>{{this}}</li>{{/each}}</ol>{{/if}}
{{#each sections}}{{#if name}}<h3>Section {{name}} <small>({{marks}} marks)</small></h3>{{/if}}
{{#each questions}}<div class="q"><span class="no">{{no}}.</span><div class="t">{{text}}{{#if options.length}}<div class="opts">{{#each options}}<span>{{this}}</span>{{/each}}</div>{{/if}}{{#if ../../withKey}}{{#if answer}}<div class="ans">Answer: {{answer}}</div>{{/if}}{{/if}}</div><span class="m">[{{marks}}]</span></div>{{/each}}{{/each}}
<p class="end">— End of the question paper —</p>`,
    css: `${BASE_CSS}
.instr { margin: 4px 0 0 16px; padding: 0; line-height: 1.5; }
.q { display: flex; gap: 6px; margin: 7px 0; break-inside: avoid; }
.q .no { font-weight: 700; min-width: 22px; }
.q .t { flex: 1; line-height: 1.45; white-space: pre-line; }
.q .m { font-weight: 700; white-space: nowrap; }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px; margin-top: 3px; }
.ans { margin-top: 3px; color: #0F5132; font-weight: 600; }
.end { text-align: center; margin-top: 14px; color: #555; }`,
    paper: { size: 'A4', orientation: 'portrait', margin: 14, copies: ['Question paper'] },
    sample: async () => ({ data: { title: 'Half-Yearly: Science (Class VII)', className: 'Class VII', subject: 'Science', exam: 'Half-Yearly', duration: '3 h', max: 3, instructions: ['All questions are compulsory.'], sections: [{ name: 'A', marks: 3, questions: [{ no: 1, text: 'Which gas do plants take in for photosynthesis?', marks: 1, options: ['(a) Oxygen', '(b) Carbon dioxide', '(c) Nitrogen', '(d) Hydrogen'], answer: 'Carbon dioxide' }, { no: 2, text: 'Define a food chain with an example.', marks: 2, options: [], answer: '' }] }], withKey: false }, filename: 'question-paper-sample.pdf' }),
    load: async (params, userId) => {
        const data = await paperDocument(uuid(params.exam, 'exam'), uuid(params.class, 'class'), uuid(params.subject, 'subject'), userId, params.key === '1');
        return { data, filename: `${data.withKey ? 'answer-key' : 'question-paper'}-${data.subject}-${data.className}.pdf`.replace(/[^A-Za-z0-9.-]+/g, '-') };
    },
});

// ─── Report cards: CBSE term-wise, pre-primary, progress card ────────────────

/** Loads the computed results a report card shows, with the same checks as the standard report card. */
const loadResults = async (params: Record<string, string>, userId: string) => {
    const kind = (['exam', 'term', 'final'].includes(params.scope) ? params.scope : 'final') as ScopeKind;
    const id = uuid(params.id, 'exam, term or session');
    const scope = await resolveScope(kind, id);
    const a = await getUserAccess(userId);
    if (params.student) {
        const studentId = uuid(params.student, 'student');
        const e = await db.enrolment.findFirst({ where: { studentId, academicYearId: scope.yearId }, select: { sectionId: true } });
        if (!e) throw badRequest('The student was not in this session');
        if (!(a.permissions['exam.view'] && seesInFull(await sectionLimits(userId, scope.yearId), e.sectionId))) {
            if (!a.permissions['exam.mine']) throw forbidden();
            await assertMine(userId, studentId, kind, id);
        }
        return { kind, id, scope, r: await computeResults(kind, id, e.sectionId, studentId) };
    }
    const sectionId = uuid(params.section, 'section');
    if (!a.permissions['exam.view'] || !seesInFull(await sectionLimits(userId, scope.yearId), sectionId)) throw forbidden('Report cards are for the class teacher and the office');
    return { kind, id, scope, r: await computeResults(kind, id, sectionId) };
};

/** Shared card parts: student with photo, health, attendance, co-scholastic, remarks, signature. */
const cardBase = async (x: Awaited<ReturnType<typeof loadResults>>) => {
    const { r, scope } = x;
    const [sign, health] = await Promise.all([principalSignature(), healthFor(scope.yearId, scope.term?.id ?? null, r.students.map((s) => s.student.id))]);
    const photos = new Map<string, string | null>();
    for (const s of r.students) photos.set(s.student.id, await photoData(s.student.photoFileId));
    return r.students.map((s) => ({
        title: r.scope.label,
        year: r.year,
        classTeacher: r.section.classTeacher ?? '',
        signature: sign,
        student: { ...s.student, section: r.section.label, className: r.section.className, photo: photos.get(s.student.id) ?? null },
        health: health(s.student.id),
        attendance: s.attendance ? `${num(s.attendance.present)} / ${s.attendance.days}${s.attendance.percent != null ? ` (${num(s.attendance.percent)}%)` : ''}` : null,
        co: s.co,
        discipline: s.discipline,
        remark: s.remark,
        result: s.result ?? 'Result not ready',
        failedSubjects: s.failedSubjects.join(', '),
        afterSupplementary: s.afterSupplementary.join(', '),
        promotedTo: s.promotedTo,
        rank: s.rank,
        gradeKey: r.rule.descriptive ? r.rule.bands.map((b) => b.grade).join(' · ') : r.rule.bands.map((b) => `${b.grade} ${b.min}+`).join(' · '),
    }));
};

const STUDENT_BLOCK = `<div class="who"><table class="info">
<tr><td>Name</td><td><b>{{student.name}}</b></td><td>Class / Section</td><td><b>{{student.section}}</b></td></tr>
<tr><td>Admission no.</td><td>{{student.admissionNo}}</td><td>Roll no.</td><td>{{student.roll}}</td></tr>
<tr><td>Father</td><td>{{student.father}}</td><td>Mother</td><td>{{student.mother}}</td></tr>
<tr><td>Date of birth</td><td>{{date student.dateOfBirth}}</td><td>Attendance</td><td>{{attendance}}</td></tr></table>
{{#if student.photo}}<img class="photo" src="{{student.photo}}" alt="">{{/if}}</div>`;
const FOOT = `{{#if co.length}}<h3>Co-scholastic areas</h3><table class="grid half"><tbody>{{#each co}}<tr><td class="l">{{area}}</td><td><b>{{#if grade}}{{grade}}{{else}}—{{/if}}</b></td></tr>{{/each}}{{#if discipline}}<tr><td class="l">Discipline</td><td><b>{{discipline}}</b></td></tr>{{/if}}</tbody></table>{{/if}}
{{#if health}}<h3>Health and activities</h3><table class="info"><tr><td>Height</td><td>{{health.height}}</td><td>Weight</td><td>{{health.weight}}</td></tr><tr><td>Vision</td><td>{{health.vision}}</td><td>Activities</td><td>{{health.activities}}</td></tr></table>{{/if}}
<div class="result"><p><b>Result:</b> {{result}}{{#if failedSubjects}} ({{failedSubjects}}){{/if}}{{#if rank}} · <b>Rank:</b> {{rank}}{{/if}}</p>
{{#if afterSupplementary}}<p><b>Passed after the supplementary exam in:</b> {{afterSupplementary}}</p>{{/if}}
{{#if promotedTo}}<p><b>Promoted to:</b> {{promotedTo}}</p>{{/if}}
{{#if remark}}<p><b>Class teacher’s remarks:</b> {{remark}}</p>{{/if}}</div>
<p class="key">Grades: {{gradeKey}}</p>
<div class="sign"><div>Class teacher<br><small>{{classTeacher}}</small></div><div>{{#if signature}}<img src="{{signature}}" alt="">{{/if}}Principal</div><div>Parent</div></div>`;
const CARD_CSS = `${BASE_CSS}
.who { display: flex; gap: 10px; align-items: flex-start; }
.who table { flex: 1; }
.photo { width: 78px; height: 96px; object-fit: cover; border: 1px solid #999; }
table.half { width: 55%; }
table.grid tr.fail td { color: #c53030; }
table.grid tr.sum td { font-weight: 700; background: #EEF2F7; }
.result { margin-top: 10px; line-height: 1.6; }
.key { font-size: 9px; color: #666; margin-top: 6px; }`;

/** CBSE: exams grouped by term (each exam's marks, the term's total % and grade), then the overall. */
const cbseCards = async (x: Awaited<ReturnType<typeof loadResults>>, senior: boolean) => {
    const { r } = x;
    const base = await cardBase(x);
    const exams = await db.exam.findMany({ where: { id: { in: r.exams.map((e) => e.id) } }, select: { id: true, termId: true, term: { select: { name: true, sortOrder: true } } } });
    const termOf = (id: string) => exams.find((e) => e.id === id);
    const groups: { key: string; name: string; order: number; exams: typeof r.exams }[] = [];
    for (const e of r.exams) {
        const t = termOf(e.id);
        const key = t?.termId ?? 'none';
        let g = groups.find((y) => y.key === key);
        if (!g) groups.push((g = { key, name: t?.term?.name ?? r.scope.label, order: t?.term?.sortOrder ?? 0, exams: [] }));
        g.exams.push(e);
    }
    groups.sort((a, b) => a.order - b.order);
    const lastId = r.exams[r.exams.length - 1]?.id;
    const lastParts = senior && lastId ? await db.examSubject.findMany({ where: { examId: lastId, classId: (await db.section.findFirst({ where: { id: r.section.id }, select: { classId: true } }))!.classId }, select: { subjectId: true, components: true } }) : [];
    return r.students.map((s, i) => ({
        ...base[i],
        terms: groups.map((g) => ({ name: g.name, span: g.exams.length + 1, exams: g.exams.map((e) => ({ name: e.shortName, weightage: e.weightage })) })),
        senior,
        rows: s.subjects.map((sub) => {
            const cells: { text: string; total?: boolean }[] = [];
            for (const g of groups) {
                let w = 0;
                let acc = 0;
                for (const e of g.exams) {
                    const m = sub.exams.find((y) => y.examId === e.id);
                    cells.push({ text: !m ? '—' : m.status !== 'P' && m.status !== 'none' ? m.status : m.obtained == null ? '—' : `${num(m.obtained)}/${m.max}` });
                    if (m && m.obtained != null && m.max) {
                        const wt = e.weightage || 1;
                        w += wt;
                        acc += wt * ((m.obtained / m.max) * 100);
                    }
                }
                const pct = w ? Math.round((acc / w) * 10) / 10 : null;
                cells.push({ text: pct == null ? '—' : `${num(pct)} (${gradeOf(r.rule.bands, pct)?.grade ?? ''})`, total: true });
            }
            const lp = lastParts.find((p) => p.subjectId === sub.subjectId);
            const lm = sub.exams.find((y) => y.examId === lastId);
            return { subject: sub.subject, cells, parts: lp && lm ? (lp.components as Part[]).map((c) => `${c.label} ${num(lm.parts[c.key] ?? null)}/${c.max}`).join(' · ') : '', percent: sub.percent == null ? '—' : `${num(sub.percent)}%`, grade: sub.grade ?? '—', failed: sub.passed === false, supplementary: !!sub.supplementary };
        }),
        percent: s.percent == null ? null : `${num(s.percent)}%`,
        grade: s.grade,
    }));
};

defineDocument({
    key: 'report_card_cbse',
    label: 'Report card (CBSE, term-wise)',
    description: 'CBSE style: each term’s exams (periodic test, notebook, subject enrichment, half-yearly…) with the term’s total and grade, then the overall; co-scholastic, health, attendance, remarks. For IX–XII (“CBSE senior”) the theory / practical marks of the last exam are shown too.',
    fields: [
        { key: '#each terms → name, span, #each exams → name, weightage', label: 'Column heads: terms and their exams' },
        { key: '#each rows → subject, #each cells → text, total, parts, percent, grade, failed, supplementary', label: 'Subjects' },
        { key: 'percent / grade / result / rank / promotedTo / afterSupplementary', label: 'Overall' },
        { key: 'student.* (photo) / health.* / co / attendance / remark / signature', label: 'Student and the rest' },
    ],
    html: `${HEAD}
<h2 class="title">REPORT CARD · {{upper title}} · {{year}}</h2>
${STUDENT_BLOCK}
<h3>Scholastic areas</h3>
<table class="grid"><thead><tr><th class="l" rowspan="2">Subject</th>{{#each terms}}<th colspan="{{span}}">{{name}}</th>{{/each}}{{#if senior}}<th rowspan="2">Theory / practical</th>{{/if}}<th rowspan="2">Overall</th><th rowspan="2">Grade</th></tr>
<tr>{{#each terms}}{{#each exams}}<th>{{name}}{{#if weightage}}<small> ({{weightage}})</small>{{/if}}</th>{{/each}}<th>Total</th>{{/each}}</tr></thead>
<tbody>{{#each rows}}<tr{{#if failed}} class="fail"{{/if}}><td class="l">{{subject}}{{#if supplementary}} *{{/if}}</td>{{#each cells}}<td>{{#if total}}<b>{{text}}</b>{{else}}{{text}}{{/if}}</td>{{/each}}{{#if ../senior}}<td><small>{{parts}}</small></td>{{/if}}<td>{{percent}}</td><td><b>{{grade}}</b></td></tr>{{/each}}
{{#if percent}}<tr class="sum"><td class="l">Overall</td><td colspan="100">{{percent}} · Grade {{grade}}</td></tr>{{/if}}</tbody></table>
${FOOT}`,
    css: CARD_CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 10, copies: ['Report card'] },
    sample: async () => {
        const { examId, sectionId } = await sampleExamSection();
        const cards = await cbseCards({ ...(await (async () => ({ kind: 'exam' as ScopeKind, id: examId, scope: await resolveScope('exam', examId), r: await computeResults('exam', examId, sectionId) }))()) }, false);
        if (!cards.length) throw badRequest('That section has no students');
        return { data: cards[0], filename: 'report-card-cbse-sample.pdf' };
    },
    load: async (params, userId) => {
        const x = await loadResults(params, userId);
        const cards = await cbseCards(x, params.senior === '1' || x.r.rule.cardFormat === 'cbse_senior');
        if (!cards.length) throw badRequest('No students');
        return { data: cards[0], many: cards, filename: `report-cards-${cards[0].student.section}.pdf` };
    },
});

defineDocument({
    key: 'report_card_preprimary',
    label: 'Report card (pre-primary)',
    description: 'For nursery / KG: each area with its grade (no marks), co-scholastic skills, health, attendance and remarks.',
    fields: [{ key: '#each rows → subject, grade · co · health · attendance · remark', label: 'Areas and the rest' }],
    html: `${HEAD}
<h2 class="title">PROGRESS REPORT · {{upper title}} · {{year}}</h2>
${STUDENT_BLOCK}
<h3>Learning areas</h3>
<table class="grid half"><thead><tr><th class="l">Area</th><th>Grade</th></tr></thead><tbody>{{#each rows}}<tr><td class="l">{{subject}}</td><td><b>{{grade}}</b></td></tr>{{/each}}</tbody></table>
${FOOT}`,
    css: CARD_CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 12, copies: ['Report card'] },
    sample: async () => ({ data: { title: 'Term 1', year: '2026-27', student: { name: 'Aarav Negi', section: 'UKG-A', admissionNo: '2026/0010', roll: 3 }, rows: [{ subject: 'English (speaking)', grade: 'A' }, { subject: 'Numbers', grade: 'B' }], co: [], result: 'Completed', gradeKey: 'A · B · C' }, filename: 'report-card-preprimary-sample.pdf' }),
    load: async (params, userId) => {
        const x = await loadResults(params, userId);
        const base = await cardBase(x);
        const cards = x.r.students.map((s, i) => ({ ...base[i], rows: s.subjects.map((sub) => ({ subject: sub.subject, grade: sub.grade ?? (sub.percent != null ? (gradeOf(x.r.rule.bands, sub.percent)?.grade ?? '—') : '—') })) }));
        if (!cards.length) throw badRequest('No students');
        return { data: cards[0], many: cards, filename: `progress-reports-${cards[0].student.section}.pdf` };
    },
});

/** A small bar chart (SVG) of the overall % in each exam. */
const chart = (bars: { label: string; value: number | null }[]) => {
    const w = 520;
    const h = 150;
    const bw = Math.min(60, Math.floor((w - 40) / Math.max(1, bars.length)) - 14);
    const parts = bars.map((b, i) => {
        const x = 40 + i * (bw + 14);
        const v = b.value ?? 0;
        const bh = Math.round((v / 100) * (h - 40));
        return `<rect x="${x}" y="${h - 22 - bh}" width="${bw}" height="${bh}" fill="#1A365D" rx="3"/><text x="${x + bw / 2}" y="${h - 26 - bh}" font-size="10" text-anchor="middle">${b.value == null ? '' : `${num(b.value)}%`}</text><text x="${x + bw / 2}" y="${h - 8}" font-size="9" text-anchor="middle">${b.label.replace(/[<&>]/g, '')}</text>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="36" y1="${h - 22}" x2="${w}" y2="${h - 22}" stroke="#999"/>${parts.join('')}</svg>`;
};

defineDocument({
    key: 'progress_card',
    label: 'Progress card (all exams)',
    description: 'One page per student: every exam of the session side by side for each subject, the overall % of each exam as a bar chart, and the session’s result so far.',
    fields: [
        { key: '#each exams → name', label: 'Column heads' },
        { key: '#each rows → subject, #each cells → text, percent', label: 'Subjects' },
        { key: 'chart', label: 'The bar chart (use {{{chart}}})' },
    ],
    html: `${HEAD}
<h2 class="title">PROGRESS CARD · {{year}}</h2>
${STUDENT_BLOCK}
<h3>Marks in each exam</h3>
<table class="grid"><thead><tr><th class="l">Subject</th>{{#each exams}}<th>{{name}}</th>{{/each}}<th>Overall</th></tr></thead>
<tbody>{{#each rows}}<tr><td class="l">{{subject}}</td>{{#each cells}}<td>{{this}}</td>{{/each}}<td><b>{{percent}}</b></td></tr>{{/each}}
<tr class="sum"><td class="l">Overall %</td>{{#each overall}}<td>{{this}}</td>{{/each}}<td>{{percent}}</td></tr></tbody></table>
<h3>Overall % in each exam</h3>
<div class="chart">{{{chart}}}</div>
${FOOT}`,
    css: CARD_CSS,
    paper: { size: 'A4', orientation: 'portrait', margin: 12, copies: ['Progress card'] },
    sample: async () => ({ data: { year: '2026-27', student: { name: 'Rohan Negi', section: 'VII-B' }, exams: [{ name: 'PT1' }, { name: 'HY' }], rows: [{ subject: 'Science', cells: ['32/40', '61/80'], percent: '78%' }], overall: ['80%', '76%'], percent: '78%', chart: chart([{ label: 'PT1', value: 80 }, { label: 'HY', value: 76 }]), co: [], result: 'Passed', gradeKey: '' }, filename: 'progress-card-sample.pdf' }),
    load: async (params, userId) => {
        const x = await loadResults({ ...params, scope: 'final' }, userId);
        const base = await cardBase(x);
        const cards = x.r.students.map((s, i) => {
            const overall = x.r.exams.map((e) => {
                const rows = s.subjects.map((sub) => sub.exams.find((y) => y.examId === e.id)).filter((m) => m && m.obtained != null && m.max);
                const max = rows.reduce((t, m) => t + m!.max, 0);
                return max ? Math.round((rows.reduce((t, m) => t + m!.obtained!, 0) / max) * 1000) / 10 : null;
            });
            return {
                ...base[i],
                exams: x.r.exams.map((e) => ({ name: e.shortName })),
                rows: s.subjects.map((sub) => ({ subject: sub.subject, cells: x.r.exams.map((e) => { const m = sub.exams.find((y) => y.examId === e.id); return !m ? '—' : m.status !== 'P' && m.status !== 'none' ? m.status : m.obtained == null ? '—' : `${num(m.obtained)}/${m.max}`; }), percent: sub.percent == null ? '—' : `${num(sub.percent)}%` })),
                overall: overall.map((v) => (v == null ? '—' : `${num(v)}%`)),
                percent: s.percent == null ? '—' : `${num(s.percent)}%`,
                chart: chart(x.r.exams.map((e, k) => ({ label: e.shortName, value: overall[k] }))),
            };
        });
        if (!cards.length) throw badRequest('No students');
        return { data: cards[0], many: cards, filename: `progress-cards-${cards[0].student.section}.pdf` };
    },
});

