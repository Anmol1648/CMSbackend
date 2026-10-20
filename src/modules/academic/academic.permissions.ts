import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import { auditModel, db } from '../../core/db';
import { registerImport } from '../imports/import.service';
import { registerMasterUsage } from '../masters/masters.registry';
import './academic.settings';
import './academic.masters';
import { createSection, updateSection } from './classes.service';
import { createSubject, updateSubject } from './subjects.service';

registerPermissions({ key: 'academic', label: 'Academic setup', order: 15 }, [
    { resource: 'academic', action: 'view', label: 'See academic years, classes, sections and subjects' },
    { resource: 'academic', action: 'manage', label: 'Set up academic years, classes, sections, subjects and class teachers' },
]);

registerMenuItems([
    { key: 'academic-years', label: 'Academic Years', icon: 'calendar_month', href: '/academic/years', group: 'configuration', order: 20, permission: 'academic.view' },
    { key: 'classes', label: 'Classes & Sections', icon: 'meeting_room', href: '/academic/classes', group: 'configuration', order: 30, permission: 'academic.view' },
    { key: 'subjects', label: 'Subjects', icon: 'menu_book', href: '/academic/subjects', group: 'configuration', order: 40, permission: 'academic.view' },
]);

// Field-level history of each record (the subjects of a class are recorded as one "subjects changed" entry).
auditModel('AcademicYear', 'academic_year');
auditModel('SchoolClass', 'class');
auditModel('Section', 'section');
auditModel('Subject', 'subject');

// Options of these master lists can't be deleted while classes, sections or subjects use them.
registerMasterUsage('class_group', { label: 'classes', count: (ids) => db.schoolClass.count({ where: { groupId: { in: ids } } }) });
registerMasterUsage('stream', {
    label: 'sections or class subjects',
    count: async (ids) => (await db.section.count({ where: { streamId: { in: ids } } })) + (await db.classSubject.count({ where: { streamId: { in: ids } } })),
});
registerMasterUsage('subject_type', { label: 'subjects', count: (ids) => db.subject.count({ where: { typeId: { in: ids } } }) });

// ─── Excel imports ───────────────────────────────────────────────────────────

const YES_NO = ['Yes', 'No'];
const ASSESSMENT: Record<string, 'scholastic' | 'co_scholastic'> = { Scholastic: 'scholastic', 'Co-scholastic': 'co_scholastic' };

interface SubjectCtx {
    byName: Map<string, string>;
    types: Map<string, string>;
    seen: Set<string>;
}

registerImport<SubjectCtx>({
    kind: 'subjects',
    label: 'Subjects',
    permission: 'academic.manage',
    columns: async () => {
        const types = await db.masterValue.findMany({ where: { master: 'subject_type', isActive: true }, select: { name: true }, orderBy: { sortOrder: 'asc' } });
        return [
            { key: 'name', header: 'Name', type: 'text', required: true, max: 80, help: 'A row with the name of an existing subject updates it.', example: 'Mathematics' },
            { key: 'code', header: 'Code', type: 'text', max: 20, help: 'Optional short code.', example: 'MAT' },
            { key: 'type', header: 'Type', type: 'choice', choices: types.map((t) => t.name), example: 'Theory' },
            {
                key: 'assessment',
                header: 'Assessment',
                type: 'choice',
                choices: Object.keys(ASSESSMENT),
                choiceHelp: { Scholastic: 'Marks or grades on the report card.', 'Co-scholastic': 'Art, PE, work education… graded separately.' },
                help: 'Empty = Scholastic.',
            },
            { key: 'active', header: 'Active', type: 'choice', choices: YES_NO, help: 'Empty = Yes.' },
        ];
    },
    prepare: async () => {
        const [subjects, types] = await Promise.all([
            db.subject.findMany({ select: { id: true, name: true } }),
            db.masterValue.findMany({ where: { master: 'subject_type' }, select: { id: true, name: true } }),
        ]);
        return { byName: new Map(subjects.map((s) => [s.name.toLowerCase(), s.id])), types: new Map(types.map((t) => [t.name.toLowerCase(), t.id])), seen: new Set() };
    },
    check: (row, ctx) => {
        const name = String(row.values.name ?? '').trim().toLowerCase();
        if (ctx.seen.has(name)) row.issues.push({ field: 'Name', message: 'appears twice in the file' });
        ctx.seen.add(name);
    },
    importRow: async (row, ctx) => {
        const v = row.values;
        const input = {
            name: String(v.name).trim(),
            code: (v.code as string | null) ?? null,
            typeId: v.type ? ctx.types.get(String(v.type).toLowerCase()) ?? null : null,
            assessment: ASSESSMENT[String(v.assessment ?? 'Scholastic')] ?? 'scholastic',
            isActive: v.active !== 'No',
        };
        const id = ctx.byName.get(input.name.toLowerCase());
        const saved = id ? await updateSubject(id, input) : await createSubject(input);
        ctx.byName.set(saved.name.toLowerCase(), saved.id);
        return { Name: saved.name, Code: saved.code ?? '', Result: id ? 'Updated' : 'Added' };
    },
});

interface SectionCtx {
    years: Map<string, string>;
    classes: Map<string, { id: string; hasStreams: boolean }>;
    streams: Map<string, string>;
    teachers: Map<string, string>;
    existing: Map<string, string>;
    seen: Set<string>;
}

registerImport<SectionCtx>({
    kind: 'sections',
    label: 'Sections',
    permission: 'academic.manage',
    columns: async () => {
        const [years, classes, streams] = await Promise.all([
            db.academicYear.findMany({ where: { status: 'open' }, select: { name: true }, orderBy: { startDate: 'desc' } }),
            db.schoolClass.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { sortOrder: 'asc' } }),
            db.masterValue.findMany({ where: { master: 'stream', isActive: true }, select: { name: true }, orderBy: { sortOrder: 'asc' } }),
        ]);
        return [
            { key: 'year', header: 'Academic year', type: 'choice', required: true, choices: years.map((y) => y.name), example: years[0]?.name ?? '' },
            { key: 'class', header: 'Class', type: 'choice', required: true, choices: classes.map((c) => c.name), example: 'Class VI' },
            { key: 'name', header: 'Section', type: 'text', required: true, max: 20, help: 'A row with an existing section (same year and class) updates it.', example: 'A' },
            { key: 'stream', header: 'Stream', type: 'choice', choices: streams.map((s) => s.name), help: 'Only for classes with streams (XI, XII).' },
            { key: 'capacity', header: 'Capacity', type: 'number', help: 'Optional: most students in the section.' },
            { key: 'room', header: 'Room', type: 'text', max: 40 },
            { key: 'teacher', header: 'Class teacher (employee code)', type: 'text', help: 'Optional: the class teacher’s employee code (Staff).' },
        ];
    },
    prepare: async () => {
        const [years, classes, streams, teachers, sections] = await Promise.all([
            db.academicYear.findMany({ select: { id: true, name: true } }),
            db.schoolClass.findMany({ select: { id: true, name: true, hasStreams: true } }),
            db.masterValue.findMany({ where: { master: 'stream' }, select: { id: true, name: true } }),
            db.staff.findMany({ where: { status: 'working' }, select: { id: true, employeeCode: true } }),
            db.section.findMany({ select: { id: true, academicYearId: true, classId: true, name: true } }),
        ]);
        return {
            years: new Map(years.map((y) => [y.name.toLowerCase(), y.id])),
            classes: new Map(classes.map((c) => [c.name.toLowerCase(), { id: c.id, hasStreams: c.hasStreams }])),
            streams: new Map(streams.map((s) => [s.name.toLowerCase(), s.id])),
            teachers: new Map(teachers.map((t) => [t.employeeCode.toLowerCase(), t.id])),
            existing: new Map(sections.map((s) => [`${s.academicYearId}|${s.classId}|${s.name.toLowerCase()}`, s.id])),
            seen: new Set(),
        };
    },
    check: (row, ctx) => {
        const v = row.values;
        const cls = ctx.classes.get(String(v.class ?? '').toLowerCase());
        if (cls?.hasStreams && !v.stream) row.issues.push({ field: 'Stream', message: 'is required for this class' });
        if (cls && !cls.hasStreams && v.stream) row.issues.push({ field: 'Stream', message: 'this class has no streams' });
        if (v.capacity !== null && v.capacity !== undefined && (!Number.isInteger(v.capacity) || (v.capacity as number) < 1 || (v.capacity as number) > 500)) {
            row.issues.push({ field: 'Capacity', message: 'must be a whole number from 1 to 500' });
        }
        if (v.teacher && !ctx.teachers.has(String(v.teacher).trim().toLowerCase())) row.issues.push({ field: 'Class teacher (employee code)', message: 'is not a working staff member' });
        const key = `${v.year}|${v.class}|${String(v.name ?? '').toLowerCase()}`;
        if (ctx.seen.has(key)) row.issues.push({ field: 'Section', message: 'appears twice in the file' });
        ctx.seen.add(key);
    },
    importRow: async (row, ctx) => {
        const v = row.values;
        const academicYearId = ctx.years.get(String(v.year).toLowerCase())!;
        const classId = ctx.classes.get(String(v.class).toLowerCase())!.id;
        const name = String(v.name).trim();
        const fields = {
            name,
            streamId: v.stream ? ctx.streams.get(String(v.stream).toLowerCase()) ?? null : null,
            capacity: (v.capacity as number | null) ?? null,
            room: (v.room as string | null) ?? null,
            classTeacherId: v.teacher ? ctx.teachers.get(String(v.teacher).trim().toLowerCase()) ?? null : null,
        };
        const key = `${academicYearId}|${classId}|${name.toLowerCase()}`;
        const id = ctx.existing.get(key);
        const saved = id ? await updateSection(id, fields) : await createSection({ academicYearId, classId, ...fields });
        ctx.existing.set(key, saved.id);
        return { Year: String(v.year), Class: String(v.class), Section: saved.name, Result: id ? 'Updated' : 'Added' };
    },
});
