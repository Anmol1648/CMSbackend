import ExcelJS from 'exceljs';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { fullName } from '../students/students.service';
import { askAi } from '../ai/ai.service';
import { getSheet } from './marks.service';
import { computeResults, ScopeKind } from './results.service';
import { EXAMS2 } from './exams2.settings';

/**
 * Faster entry: a marks sheet as an Excel file (fill offline, upload: the marks come back into the
 * sheet on screen to check and save), health and activities for the report card, and remark
 * suggestions (the school's remark bank by score, or the AI).
 */

const ID_COL = 'Student ID (do not change)';

/** The sheet as an Excel file: roll, admission no, name, status, one column per part. */
export const sheetExcel = async (examSubjectId: string, sectionId: string, userId: string) => {
    const s = await getSheet(examSubjectId, sectionId, userId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Marks');
    const partCols = s.descriptive ? ['Grade'] : s.parts.map((p) => `${p.label} (max ${p.max})`);
    ws.addRow([`${s.exam.name} · ${s.subject} · ${s.section}`]);
    ws.addRow(['Status: P = present (fill marks), or AB / ML / NA. Leave marks empty for not entered.']);
    ws.addRow(['Roll', 'Adm. no.', 'Name', 'Status', ...partCols, ID_COL]);
    ws.getRow(3).font = { bold: true };
    for (const st of s.students) ws.addRow([st.roll ?? '', st.admissionNo, st.name, st.status, ...(s.descriptive ? [st.marks.grade ?? ''] : s.parts.map((p) => st.marks[p.key] ?? '')), st.id]);
    ws.columns.forEach((c, i) => (c.width = i === 2 ? 28 : i === 4 + partCols.length ? 38 : 14));
    ws.getColumn(5 + partCols.length).hidden = false;
    ws.getRow(1).font = { bold: true, size: 13 };
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `marks-${s.subject}-${s.section}.xlsx`.replace(/[^A-Za-z0-9.-]+/g, '-') };
};

/** Reads a filled sheet: rows to put into the sheet on screen (nothing is saved here). */
export const readSheetExcel = async (examSubjectId: string, sectionId: string, data: Buffer, userId: string) => {
    const s = await getSheet(examSubjectId, sectionId, userId);
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
    } catch {
        throw badRequest('That is not an Excel (.xlsx) file');
    }
    const ws = wb.worksheets[0];
    let header = 0;
    ws.eachRow((row, n) => {
        if (!header && row.values && (row.values as unknown[]).some((v) => String(v ?? '') === ID_COL)) header = n;
    });
    if (!header) throw badRequest('Use the file downloaded from this sheet (its last column is the student ID)');
    const heads = (ws.getRow(header).values as unknown[]).map((v) => String(v ?? ''));
    const col = (name: string) => heads.indexOf(name);
    const idCol = col(ID_COL);
    const stCol = col('Status');
    const known = new Set(s.students.map((x) => x.id));
    const rows: { studentId: string; status: string; marks: Record<string, number | string | null> }[] = [];
    const issues: string[] = [];
    for (let n = header + 1; n <= ws.rowCount; n++) {
        const r = ws.getRow(n);
        const id = String(r.getCell(idCol).value ?? '').trim();
        if (!id) continue;
        if (!known.has(id)) {
            issues.push(`Row ${n}: not a student of this sheet`);
            continue;
        }
        const status = String(r.getCell(stCol).value ?? 'P').trim().toUpperCase() || 'P';
        const marks: Record<string, number | string | null> = {};
        if (s.descriptive) {
            const g = String(r.getCell(col('Grade')).value ?? '').trim();
            if (g) marks.grade = g;
        } else
            for (const p of s.parts) {
                const raw = r.getCell(col(`${p.label} (max ${p.max})`)).value;
                const v = raw === null || raw === undefined || raw === '' ? null : Number(typeof raw === 'object' && 'result' in raw ? raw.result : raw);
                if (v !== null && (!Number.isFinite(v) || v < 0 || v > p.max)) issues.push(`Row ${n}: ${p.label} must be 0 to ${p.max}`);
                marks[p.key] = v !== null && Number.isFinite(v) ? v : null;
            }
        rows.push({ studentId: id, status, marks });
    }
    return { rows, issues };
};

// ─── Health and activities ───────────────────────────────────────────────────

const classTeacherOrOffice = async (sectionId: string, userId: string) => {
    const a = await getUserAccess(userId);
    if (a.permissions['exam.marks_any'] || a.permissions['exam.moderate']) return;
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff || !(await db.section.findFirst({ where: { id: sectionId, classTeacherId: staff.id }, select: { id: true } }))) throw forbidden('Only the class teacher (or the office) enters this');
};

export const getHealth = async (sectionId: string, termKey: string, userId: string) => {
    await classTeacherOrOffice(sectionId, userId);
    const section = await db.section.findFirst({ where: { id: sectionId }, select: { academicYearId: true } });
    if (!section) throw notFound('Section not found');
    const [enrol, rows, terms] = await Promise.all([
        db.enrolment.findMany({ where: { sectionId, student: { status: 'active' } }, orderBy: [{ rollNumber: 'asc' }], select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } }),
        db.studentHealth.findMany({ where: { academicYearId: section.academicYearId, termKey } }),
        db.examTerm.findMany({ where: { academicYearId: section.academicYearId }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    ]);
    return {
        terms,
        students: enrol.map((e) => {
            const h = rows.find((r) => r.studentId === e.student.id);
            return { id: e.student.id, name: fullName(e.student), admissionNo: e.student.admissionNo, roll: e.rollNumber, heightCm: h?.heightCm ?? null, weightKg: h?.weightKg ?? null, vision: h?.vision ?? '', activities: h?.activities ?? '' };
        }),
    };
};

export const healthSchema = z.strictObject({ termKey: z.string().max(40), rows: z.array(z.strictObject({ studentId: z.uuid(), heightCm: z.number().min(30).max(250).nullable(), weightKg: z.number().min(5).max(200).nullable(), vision: z.string().trim().max(40), activities: z.string().trim().max(300) })).max(200) });
export const saveHealth = async (sectionId: string, input: z.infer<typeof healthSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    await classTeacherOrOffice(sectionId, userId);
    const section = await db.section.findFirst({ where: { id: sectionId }, select: { academicYearId: true } });
    if (!section) throw notFound('Section not found');
    for (const r of input.rows) {
        const data = { heightCm: r.heightCm, weightKg: r.weightKg, vision: r.vision || null, activities: r.activities || null, enteredBy: userId };
        await db.studentHealth.upsert({ where: { academicYearId_termKey_studentId: { academicYearId: section.academicYearId, termKey: input.termKey, studentId: r.studentId } }, create: { ...data, tenantId: getTenantId()!, academicYearId: section.academicYearId, termKey: input.termKey, studentId: r.studentId, isDemo: !!opts.isDemo }, update: data });
    }
    return getHealth(sectionId, input.termKey, userId);
};

/** Health of students for a report card: the term's (or the session's latest). */
export const healthFor = async (yearId: string, termId: string | null, studentIds: string[]) => {
    const rows = await db.studentHealth.findMany({ where: { academicYearId: yearId, studentId: { in: studentIds } }, orderBy: { updatedAt: 'desc' } });
    const pick = (id: string) => rows.find((r) => r.studentId === id && (!termId || r.termKey === termId)) ?? rows.find((r) => r.studentId === id);
    return (id: string) => {
        const h = pick(id);
        return h ? { height: h.heightCm ? `${h.heightCm} cm` : '', weight: h.weightKg ? `${h.weightKg} kg` : '', vision: h.vision ?? '', activities: h.activities ?? '' } : null;
    };
};

// ─── Remarks ─────────────────────────────────────────────────────────────────

/** The remark bank for a score: the remarks marked for its band, then the general ones. */
export const bankRemarks = async (percent: number | null) => {
    const rows = await db.masterValue.findMany({ where: { master: 'report_remark', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { name: true, extra: true } });
    const band = percent == null ? null : percent >= 75 ? 'high' : percent >= 50 ? 'mid' : 'low';
    const of = (r: (typeof rows)[number]) => ((r.extra ?? {}) as { band?: string }).band ?? '';
    if (!band) return rows.map((r) => r.name);
    return [...rows.filter((r) => of(r) === band), ...rows.filter((r) => !of(r))].map((r) => r.name);
};

/** A remark written by the AI from the student's result (the teacher edits it before saving). */
export const aiRemark = async (kind: ScopeKind, scopeId: string, sectionId: string, studentId: string, userId: string) => {
    await classTeacherOrOffice(sectionId, userId);
    const { on } = await getSettings({ on: EXAMS2.aiRemarks });
    if (!on) throw forbidden('AI remarks are off (System Settings → Exams)');
    const r = await computeResults(kind, scopeId, sectionId, studentId);
    const s = r.students[0];
    if (!s) throw notFound('No result for this student');
    const facts = [`Student first name: ${s.student.name.split(' ')[0]}`, `Result: ${r.scope.label}`, ...s.subjects.map((x) => `${x.subject}: ${x.percent ?? '-'}%${x.grade ? ` (${x.grade})` : ''}`), s.percent != null ? `Overall: ${s.percent}%` : '', s.attendance?.percent != null ? `Attendance: ${s.attendance.percent}%` : '', ...s.co.filter((c) => c.grade).map((c) => `${c.area}: ${c.grade}`)].filter(Boolean).join('\n');
    const text = await askAi('exam_remark', userId, {
        system: 'You write report card remarks for an Indian school. Write 2 short, warm, specific sentences (max 40 words) for the class teacher to sign: one strength, one thing to work on. Plain English, no names other than the first name given, no marks or percentages, no emojis.',
        messages: [{ role: 'user', text: facts }],
        maxTokens: 160,
        temperature: 0.6,
    });
    return { remark: text.trim().replace(/^["“]|["”]$/g, '') };
};
