import { registerPermissions } from '../../core/registry/permissions';
import { classesOfYear } from '../academic/year-classes.service';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { auditModel, db } from '../../core/db';
import type { ParsedRow } from '../../core/excel';
import { registerImport } from '../imports/import.service';
import { registerMasterUsage } from '../masters/masters.registry';
import { registerSectionUsage } from '../academic/classes.service';
import { currentYear } from '../academic/years.service';
import { normalizeMobile } from '../auth/identity';
import './students.settings';
import './students.masters';
import { admitStudent } from './students.service';
import type { GuardianInput } from './family.service';
import { importExtras } from '../forms/forms.service';

registerPermissions({ key: 'students', label: 'Students', order: 30 }, [
    { resource: 'student', action: 'view', label: 'See students', description: 'Assigned = students of the sections the person is class teacher of. Own = the student themself, or a parent’s children.', scopes: ['all', 'assigned', 'own'] },
    { resource: 'student', action: 'create', label: 'Admit students' },
    { resource: 'student', action: 'update', label: 'Edit students, their parents, section, documents and logins' },
    { resource: 'student', action: 'import', label: 'Import students from Excel' },
    { resource: 'student', action: 'view_sensitive', label: 'See Aadhaar numbers, family income and medical notes', sensitive: true },
]);

registerMenuGroup({ key: 'students', label: 'Students', order: 10 });
registerMenuItems([
    { key: 'students', label: 'Students', icon: 'groups', href: '/students', group: 'students', order: 10, permission: 'student.view' },
    { key: 'admission', label: 'New Admission', icon: 'person_add', href: '/students/new', group: 'students', order: 20, permission: 'student.create' },
]);

// History of every change (Aadhaar and medical notes are left out of it).
auditModel('Student', 'student', ['aadhaar', 'medicalNotes']);
auditModel('Guardian', 'guardian', ['aadhaar']);

// What students and parents use can't be deleted from the lists or academic set-up.
const studentField = (master: string, column: string) =>
    registerMasterUsage(master, { label: 'students', count: (ids) => db.student.count({ where: { [column]: { in: ids } } }) });
studentField('gender', 'genderId');
studentField('blood_group', 'bloodGroupId');
studentField('religion', 'religionId');
studentField('caste_category', 'casteCategoryId');
studentField('mother_tongue', 'motherTongueId');
studentField('nationality', 'nationalityId');
studentField('disability', 'disabilityId');
studentField('student_category', 'categoryId');
studentField('admission_type', 'admissionTypeId');
studentField('state', 'stateId');
studentField('district', 'districtId');
studentField('city', 'cityId');
studentField('previous_board', 'previousBoardId');
studentField('leaving_reason', 'leavingReasonId');
const guardianField = (master: string, column: string) =>
    registerMasterUsage(master, { label: 'parents / guardians', count: (ids) => db.guardian.count({ where: { [column]: { in: ids } } }) });
guardianField('relation', 'relationId');
guardianField('occupation', 'occupationId');
guardianField('qualification', 'qualificationId');
guardianField('income_range', 'incomeRangeId');
registerMasterUsage('house', { label: 'students', count: (ids) => db.enrolment.count({ where: { houseId: { in: ids } } }) });
registerMasterUsage('student_document', { label: 'documents', count: (ids) => db.studentDocument.count({ where: { typeId: { in: ids } } }) });
registerSectionUsage({ label: 'students', count: (sectionId) => db.enrolment.count({ where: { sectionId } }) });

// ─── Excel import ────────────────────────────────────────────────────────────

/** Master columns of the import: header, key, list. */
const LISTS: [string, string, string][] = [
    ['Gender', 'genderId', 'gender'],
    ['Blood group', 'bloodGroupId', 'blood_group'],
    ['Religion', 'religionId', 'religion'],
    ['Caste category', 'casteCategoryId', 'caste_category'],
    ['Admission category', 'categoryId', 'student_category'],
    ['Mother tongue', 'motherTongueId', 'mother_tongue'],
    ['State', 'stateId', 'state'],
    ['District', 'districtId', 'district'],
    ['City / town', 'cityId', 'city'],
];

interface StudentImportCtx {
    yearId: string;
    lists: Map<string, Map<string, string>>;
    classes: Map<string, string>;
    sections: Map<string, string>;
    houses: Map<string, string>;
    relations: Map<string, string>;
    families: Map<string, string>;
    userId: string;
    /** Extra fields of the Form Builder. */
    extras: Awaited<ReturnType<typeof importExtras>>;
}

const choicesOf = async (master: string) => (await db.masterValue.findMany({ where: { master, isActive: true }, select: { name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((m) => m.name);

registerImport<StudentImportCtx>({
    kind: 'students',
    label: 'Students',
    permission: 'student.import',
    columns: async () => {
        const year = await currentYear();
        const classes = await classesOfYear(year?.id);
        const houses = await choicesOf('house');
        // One list at a time: many parallel queries can run out of database connections.
        const simple: { header: string; key: string; choices: string[] }[] = [];
        for (const [header, key, master] of LISTS.filter(([, , m]) => !['district', 'city'].includes(m))) simple.push({ header, key, choices: await choicesOf(master) });
        return (await importExtras('student')).adjust([
            { key: 'admissionNo', header: 'Admission no', type: 'text', max: 40, help: 'Empty = given automatically (System Settings → Students).', example: '' },
            { key: 'admissionDate', header: 'Admission date', type: 'date', help: 'Empty = today.' },
            { key: 'firstName', header: 'First name', type: 'text', required: true, max: 80, example: 'Riya' },
            { key: 'middleName', header: 'Middle name', type: 'text', max: 80 },
            { key: 'lastName', header: 'Last name', type: 'text', max: 80, example: 'Negi' },
            { key: 'dateOfBirth', header: 'Date of birth', type: 'date', example: '15-08-2015' },
            ...simple.map((c) => ({ key: c.key, header: c.header, type: 'choice' as const, choices: c.choices })),
            { key: 'districtId', header: 'District', type: 'text', help: 'Name of a district of the state above.' },
            { key: 'cityId', header: 'City / town', type: 'text', help: 'Name of a town of the district above (optional).' },
            { key: 'addressLine', header: 'Address', type: 'text', max: 200 },
            { key: 'pinCode', header: 'PIN', type: 'text', max: 6 },
            { key: 'aadhaar', header: 'Aadhaar', type: 'text', max: 14 },
            { key: 'class', header: 'Class', type: 'choice', required: true, choices: classes.map((c) => c.name), help: `Placed in ${year?.name ?? 'the current year'}.`, example: 'Class VI' },
            { key: 'section', header: 'Section', type: 'text', required: true, max: 20, example: 'A' },
            { key: 'rollNumber', header: 'Roll no', type: 'number', help: 'Empty = given by the roll number setting.' },
            ...(houses.length ? [{ key: 'house', header: 'House', type: 'choice' as const, choices: houses }] : []),
            { key: 'fatherName', header: 'Father name', type: 'text', max: 120, example: 'Suresh Negi' },
            { key: 'fatherMobile', header: 'Father mobile', type: 'mobile', help: 'Students with the same father or mother mobile are linked as siblings.', example: '9876543210' },
            { key: 'motherName', header: 'Mother name', type: 'text', max: 120 },
            { key: 'motherMobile', header: 'Mother mobile', type: 'mobile' },
        ]);
    },
    prepare: async (userId) => {
        const year = await currentYear();
        if (!year) throw new Error('Add an academic year first (Configuration → Academic Years)');
        const lists = new Map<string, Map<string, string>>();
        for (const [, key, master] of LISTS) {
            const rows = await db.masterValue.findMany({ where: { master }, select: { id: true, name: true, parentId: true } });
            // District and town names repeat across states, so they are looked up with their parent.
            lists.set(key, new Map(rows.map((r) => [['districtId', 'cityId'].includes(key) ? `${r.parentId}|${r.name.toLowerCase()}` : r.name.toLowerCase(), r.id])));
        }
        const classes = await db.schoolClass.findMany({ select: { id: true, name: true } });
        const sections = await db.section.findMany({ where: { academicYearId: year.id }, select: { id: true, name: true, classId: true } });
        const houses = await db.masterValue.findMany({ where: { master: 'house' }, select: { id: true, name: true } });
        const relations = await db.masterValue.findMany({ where: { master: 'relation' }, select: { id: true, name: true } });
        const guardians = await db.guardian.findMany({ where: { mobile: { not: null } }, select: { mobile: true, familyId: true } });
        return {
            yearId: year.id,
            lists,
            classes: new Map(classes.map((c) => [c.name.toLowerCase(), c.id])),
            sections: new Map(sections.map((s) => [`${s.classId}|${s.name.toLowerCase()}`, s.id])),
            houses: new Map(houses.map((h) => [h.name.toLowerCase(), h.id])),
            relations: new Map(relations.map((r) => [r.name.toLowerCase(), r.id])),
            families: new Map(guardians.map((g) => [g.mobile!, g.familyId])),
            userId,
            extras: await importExtras('student'),
        };
    },
    check: (row: ParsedRow, ctx) => {
        const v = row.values;
        const classId = ctx.classes.get(String(v.class ?? '').toLowerCase());
        if (classId && !ctx.sections.get(`${classId}|${String(v.section ?? '').trim().toLowerCase()}`)) row.issues.push({ field: 'Section', message: `is not a section of ${v.class} this year` });
        const state = v.stateId ? ctx.lists.get('stateId')!.get(String(v.stateId).toLowerCase()) : null;
        const district = v.districtId && state ? ctx.lists.get('districtId')!.get(`${state}|${String(v.districtId).trim().toLowerCase()}`) : null;
        if (v.districtId && !district) row.issues.push({ field: 'District', message: state ? 'is not a district of the state' : 'needs the state' });
        if (v.cityId && !(district && ctx.lists.get('cityId')!.get(`${district}|${String(v.cityId).trim().toLowerCase()}`))) row.issues.push({ field: 'City / town', message: 'is not a town of the district' });
        if (!v.fatherName && !v.motherName) row.issues.push({ field: 'Father name', message: 'give the father or the mother' });
        if (v.aadhaar && !/^\d{12}$/.test(String(v.aadhaar).replace(/[\s-]/g, ''))) row.issues.push({ field: 'Aadhaar', message: 'must be 12 digits' });
        if (v.pinCode && !/^\d{6}$/.test(String(v.pinCode))) row.issues.push({ field: 'PIN', message: 'must be 6 digits' });
    },
    importRow: async (row, ctx) => {
        const v = row.values;
        const pick = (key: string, raw: unknown, parent?: string | null) => (raw ? ctx.lists.get(key)!.get(parent ? `${parent}|${String(raw).trim().toLowerCase()}` : String(raw).toLowerCase()) ?? null : null);
        const stateId = pick('stateId', v.stateId);
        const districtId = pick('districtId', v.districtId, stateId);
        const cityId = pick('cityId', v.cityId, districtId);
        const classId = ctx.classes.get(String(v.class).toLowerCase())!;
        const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : undefined);

        const guardians: GuardianInput[] = [];
        if (v.fatherName) guardians.push({ name: String(v.fatherName), mobile: (v.fatherMobile as string | null) ?? null, relationId: ctx.relations.get('father') ?? null, isPrimary: true });
        if (v.motherName) guardians.push({ name: String(v.motherName), mobile: (v.motherMobile as string | null) ?? null, relationId: ctx.relations.get('mother') ?? null, isPrimary: !v.fatherName });
        const mobiles = [v.fatherMobile, v.motherMobile].filter(Boolean).map((m) => normalizeMobile(String(m)));
        const familyId = mobiles.map((m) => ctx.families.get(m)).find(Boolean);

        const result = await admitStudent(
            {
                student: {
                    admissionNo: (v.admissionNo as string | null) ?? undefined,
                    admissionDate: day(v.admissionDate),
                    firstName: String(v.firstName),
                    middleName: (v.middleName as string | null) ?? null,
                    lastName: (v.lastName as string | null) ?? null,
                    dateOfBirth: day(v.dateOfBirth) ?? null,
                    genderId: pick('genderId', v.genderId),
                    bloodGroupId: pick('bloodGroupId', v.bloodGroupId),
                    religionId: pick('religionId', v.religionId),
                    casteCategoryId: pick('casteCategoryId', v.casteCategoryId),
                    categoryId: pick('categoryId', v.categoryId),
                    motherTongueId: pick('motherTongueId', v.motherTongueId),
                    stateId,
                    districtId,
                    cityId,
                    addressLine: (v.addressLine as string | null) ?? null,
                    pinCode: (v.pinCode as string | null) ?? null,
                    aadhaar: v.aadhaar ? String(v.aadhaar).replace(/[\s-]/g, '') : null,
                    custom: ctx.extras.toCustom(v),
                },
                ...(familyId ? { familyId } : { guardians }),
                enrolment: {
                    academicYearId: ctx.yearId,
                    sectionId: ctx.sections.get(`${classId}|${String(v.section).trim().toLowerCase()}`)!,
                    ...(v.rollNumber ? { rollNumber: Number(v.rollNumber) } : {}),
                    houseId: v.house ? ctx.houses.get(String(v.house).toLowerCase()) ?? null : null,
                },
            },
            { userId: ctx.userId, scope: 'all', sensitive: true }
        );
        // Siblings later in the same file join this family.
        if (result.student.family) for (const m of mobiles) ctx.families.set(m, result.student.family.id);
        const login = result.logins[0];
        return {
            'Admission no': result.student.admissionNo,
            Name: result.student.name,
            Section: result.student.enrolments[0]?.section.label ?? '',
            'Roll no': String(result.student.enrolments[0]?.rollNumber ?? ''),
            Username: login?.username ?? '',
            'One-time password': login?.temporaryPassword ?? '',
            Sibling: familyId ? 'Linked to existing family' : '',
        };
    },
});
