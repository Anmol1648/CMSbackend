import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { auditModel, db } from '../../core/db';
import type { ParsedRow } from '../../core/excel';
import { getSettings } from '../../core/settings';
import { registerImport } from '../imports/import.service';
import { registerMasterUsage } from '../masters/masters.registry';
import './staff.settings';
import './staff.masters';
import { STAFF } from './staff.settings';
import { createStaff } from './staff.service';

registerPermissions({ key: 'staff', label: 'Staff', order: 35 }, [
    { resource: 'staff', action: 'view', label: 'See staff', description: 'Own = only their own record.', scopes: ['all', 'own'] },
    { resource: 'staff', action: 'create', label: 'Add staff' },
    { resource: 'staff', action: 'update', label: 'Edit staff, their qualifications, documents, status and logins' },
    { resource: 'staff', action: 'import', label: 'Import staff from Excel' },
    { resource: 'staff', action: 'view_sensitive', label: 'See staff Aadhaar, PAN, bank account and PF numbers', sensitive: true },
    { resource: 'teaching', action: 'assign', label: 'Choose class teachers and subject teachers' },
]);

registerMenuGroup({ key: 'staff', label: 'Staff', order: 20 });
registerMenuItems([
    { key: 'staff', label: 'Staff', icon: 'badge', href: '/staff', group: 'staff', order: 10, permission: 'staff.view' },
    { key: 'teaching', label: 'Subject Teachers', icon: 'co_present', href: '/staff/teaching', group: 'staff', order: 20, permission: 'teaching.assign' },
]);

auditModel('Staff', 'staff', ['aadhaar', 'pan', 'bankAccountNo', 'pfNumber']);

const staffField = (master: string, column: string) =>
    registerMasterUsage(master, { label: 'staff', count: (ids) => db.staff.count({ where: { [column]: { in: ids } } }) });
for (const [master, column] of [
    ['gender', 'genderId'],
    ['blood_group', 'bloodGroupId'],
    ['religion', 'religionId'],
    ['caste_category', 'casteCategoryId'],
    ['marital_status', 'maritalStatusId'],
    ['state', 'stateId'],
    ['district', 'districtId'],
    ['city', 'cityId'],
    ['department', 'departmentId'],
    ['designation', 'designationId'],
    ['staff_type', 'staffTypeId'],
    ['employment_type', 'employmentTypeId'],
    ['teaching_post', 'teachingPostId'],
    ['bank', 'bankId'],
    ['relieving_reason', 'relievingReasonId'],
] as const) {
    staffField(master, column);
}
registerMasterUsage('qualification', { label: 'staff qualifications', count: (ids) => db.staffQualification.count({ where: { qualificationId: { in: ids } } }) });
registerMasterUsage('staff_document', { label: 'documents', count: (ids) => db.staffDocument.count({ where: { typeId: { in: ids } } }) });

// ─── Excel import ────────────────────────────────────────────────────────────

const LISTS: [string, string, string][] = [
    ['Gender', 'genderId', 'gender'],
    ['Department', 'departmentId', 'department'],
    ['Designation', 'designationId', 'designation'],
    ['Staff type', 'staffTypeId', 'staff_type'],
    ['Employment type', 'employmentTypeId', 'employment_type'],
    ['Teaching post', 'teachingPostId', 'teaching_post'],
];

interface Ctx {
    lists: Map<string, Map<string, string>>;
    teaching: Set<string>;
    loginDefault: 'teaching' | 'all' | 'none';
    userId: string;
}

registerImport<Ctx>({
    kind: 'staff',
    label: 'Staff',
    permission: 'staff.import',
    columns: async () => {
        const out = [];
        for (const [header, key, master] of LISTS) {
            const rows = await db.masterValue.findMany({ where: { master, isActive: true }, select: { name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
            out.push({ key, header, type: 'choice' as const, choices: rows.map((r) => r.name) });
        }
        return [
            { key: 'employeeCode', header: 'Employee code', type: 'text', max: 40, help: 'Empty = given automatically (System Settings → Staff).' },
            { key: 'joiningDate', header: 'Joining date', type: 'date', help: 'Empty = today.' },
            { key: 'firstName', header: 'First name', type: 'text', required: true, max: 80, example: 'Anita' },
            { key: 'middleName', header: 'Middle name', type: 'text', max: 80 },
            { key: 'lastName', header: 'Last name', type: 'text', max: 80, example: 'Negi' },
            { key: 'dateOfBirth', header: 'Date of birth', type: 'date' },
            { key: 'mobile', header: 'Mobile', type: 'mobile', unique: true, example: '9876543210' },
            { key: 'email', header: 'Email', type: 'email', unique: true },
            ...out,
            { key: 'canSignIn', header: 'Can sign in', type: 'choice', choices: ['Yes', 'No'], help: 'Empty = by System Settings → Staff (teaching staff only, by default).' },
        ];
    },
    prepare: async (userId) => {
        const lists = new Map<string, Map<string, string>>();
        for (const [, key, master] of LISTS) {
            const rows = await db.masterValue.findMany({ where: { master }, select: { id: true, name: true } });
            lists.set(key, new Map(rows.map((r) => [r.name.toLowerCase(), r.id])));
        }
        const types = await db.masterValue.findMany({ where: { master: 'staff_type' }, select: { id: true, extra: true } });
        const { loginDefault } = await getSettings({ loginDefault: STAFF.loginDefault });
        return { lists, teaching: new Set(types.filter((t) => (t.extra as { teaching?: boolean }).teaching).map((t) => t.id)), loginDefault, userId };
    },
    check: (row: ParsedRow) => {
        if (!row.values.mobile && !row.values.email && row.values.canSignIn === 'Yes') row.issues.push({ field: 'Can sign in', message: 'needs a mobile or email (to reset the password)' });
    },
    importRow: async (row, ctx) => {
        const v = row.values;
        const pick = (key: string) => (v[key] ? ctx.lists.get(key)!.get(String(v[key]).toLowerCase()) ?? null : null);
        const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : undefined);
        const staffTypeId = pick('staffTypeId');
        const signIn = v.canSignIn ? v.canSignIn === 'Yes' : ctx.loginDefault === 'all' || (ctx.loginDefault === 'teaching' && !!staffTypeId && ctx.teaching.has(staffTypeId));
        const r = await createStaff(
            {
                staff: {
                    employeeCode: (v.employeeCode as string | null) ?? undefined,
                    joiningDate: day(v.joiningDate),
                    firstName: String(v.firstName),
                    middleName: (v.middleName as string | null) ?? null,
                    lastName: (v.lastName as string | null) ?? null,
                    dateOfBirth: day(v.dateOfBirth) ?? null,
                    mobile: (v.mobile as string | null) ?? null,
                    email: (v.email as string | null) ?? null,
                    genderId: pick('genderId'),
                    departmentId: pick('departmentId'),
                    designationId: pick('designationId'),
                    staffTypeId,
                    employmentTypeId: pick('employmentTypeId'),
                    teachingPostId: pick('teachingPostId'),
                },
                login: { enabled: signIn },
            },
            { userId: ctx.userId, scope: 'all', sensitive: true }
        );
        return { 'Employee code': r.staff.employeeCode, Name: r.staff.name, Username: r.login?.username ?? '', 'One-time password': r.login?.temporaryPassword ?? '' };
    },
});
