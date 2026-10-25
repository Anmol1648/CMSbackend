import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSetting, getSettings, setSetting, SettingDef } from '../../core/settings';
import { getUserAccess, UserAccess } from '../rbac/access.service';
import { STUDENTS, STUDENT_FIELDS } from '../students/students.settings';
import { STAFF, STAFF_FIELDS } from '../staff/staff.settings';
import type { ImportColumn } from '../../core/excel';
import { CustomField, customFieldSchema, labelsSchema } from './forms.fields';

/**
 * Setup → Form Builder: for each form (student, staff), the school hides the built-in fields it
 * doesn't use, makes others required, renames any of them, and adds its own fields. Locked fields
 * (the name, admission no., employee code…) can be renamed but not hidden: the rest of the ERP
 * depends on them. Extra field values live in the record's custom_fields; a field that has values
 * is switched off rather than deleted.
 */

interface BuiltIn {
    key: string;
    label: string;
    /** Can't be hidden (renaming is allowed). */
    locked?: boolean;
    /** Can't be made required / optional here (always required, or not a single field). */
    fixedRequired?: boolean;
    /** Can only be required (not a field on the form: e.g. "at least one guardian"). */
    requireOnly?: boolean;
}
interface FormDef {
    key: 'student' | 'staff';
    label: string;
    table: 'students' | 'staff';
    builtIn: BuiltIn[];
    settings: { required: SettingDef<string[]>; hidden: SettingDef<string[]>; labels: SettingDef<Record<string, string>>; custom: SettingDef<CustomField[]> };
}

export const FORMS: Record<string, FormDef> = {
    student: {
        key: 'student',
        label: 'Student',
        table: 'students',
        builtIn: [
            { key: 'firstName', label: 'First name', locked: true, fixedRequired: true },
            { key: 'admissionNo', label: 'Admission no.', locked: true, fixedRequired: true },
            { key: 'admissionDate', label: 'Admission date', locked: true, fixedRequired: true },
            ...STUDENT_FIELDS.map((f) => (f.value === 'guardian' ? { key: f.value, label: f.label, requireOnly: true } : { key: f.value, label: f.label })),
        ],
        settings: { required: STUDENTS.requiredFields as SettingDef<string[]>, hidden: STUDENTS.hiddenFields as SettingDef<string[]>, labels: STUDENTS.fieldLabels, custom: STUDENTS.customFields },
    },
    staff: {
        key: 'staff',
        label: 'Staff',
        table: 'staff',
        builtIn: [
            { key: 'firstName', label: 'First name', locked: true, fixedRequired: true },
            { key: 'employeeCode', label: 'Employee code', locked: true, fixedRequired: true },
            { key: 'joiningDate', label: 'Date of joining', locked: true, fixedRequired: true },
            ...STAFF_FIELDS.map((f) => ({ key: f.value, label: f.label })),
        ],
        settings: { required: STAFF.requiredFields as SettingDef<string[]>, hidden: STAFF.hiddenFields as SettingDef<string[]>, labels: STAFF.fieldLabels, custom: STAFF.customFields },
    },
};

/** May this person see (and fill) the field? Super Admin sees every field. */
const canSee = (c: CustomField, access: UserAccess | null) => !c.visibleTo?.length || !access || access.isSuperAdmin || access.roles.some((r) => c.visibleTo.includes(r.id));

const formOf = (key: string) => {
    const f = FORMS[key];
    if (!f) throw notFound('Form not found');
    return f;
};

/** How many records have a value for each extra field (a used field is switched off, not deleted). */
const usage = async (f: FormDef, keys: string[]) => {
    const out: Record<string, number> = {};
    for (const k of keys) {
        const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${f.table}" WHERE tenant_id = $1::uuid AND jsonb_exists(custom_fields, $2)`, getTenantId(), k);
        out[k] = Number(rows[0]?.n ?? 0);
    }
    return out;
};

/** The Form Builder screen: every built-in field with its state, and the extra fields. */
export const getForm = async (key: string) => {
    const f = formOf(key);
    const s = await getSettings(f.settings);
    const used = await usage(f, s.custom.map((c) => c.key));
    return {
        key: f.key,
        label: f.label,
        builtIn: f.builtIn.map((b) => ({ key: b.key, defaultLabel: b.label, label: s.labels[b.key] ?? b.label, locked: !!b.locked, fixedRequired: !!b.fixedRequired, requireOnly: !!b.requireOnly, hidden: !b.locked && s.hidden.includes(b.key), required: !!b.fixedRequired || s.required.includes(b.key) })),
        custom: s.custom.map((c) => ({ ...c, visibleTo: c.visibleTo ?? [], used: used[c.key] ?? 0 })),
        roles: await db.role.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    };
};

export const listForms = async () => Object.values(FORMS).map((f) => ({ key: f.key, label: f.label }));

export const saveFormSchema = z.strictObject({
    builtIn: z.array(z.strictObject({ key: z.string().max(40), label: z.string().trim().max(60).nullable().optional(), hidden: z.boolean(), required: z.boolean() })).max(100),
    custom: z.array(customFieldSchema).max(60),
});

export const saveForm = async (key: string, input: z.infer<typeof saveFormSchema>, userId: string) => {
    const f = formOf(key);
    const before = await getSettings(f.settings);
    const known = new Map(f.builtIn.map((b) => [b.key, b]));
    const hidden: string[] = [];
    const required: string[] = [];
    const labels: Record<string, string> = {};
    for (const b of input.builtIn) {
        const def = known.get(b.key);
        if (!def) throw badRequest(`Unknown field ${b.key}`);
        if (b.label && b.label !== def.label) labels[b.key] = b.label;
        if (b.hidden && !def.locked && !def.requireOnly) hidden.push(b.key);
        if (b.required && !b.hidden && !def.fixedRequired) required.push(b.key);
    }
    // Extra fields: keys unique and not a built-in one; options for choices; a list for master fields.
    const seen = new Set<string>();
    for (const c of input.custom) {
        if (seen.has(c.key) || known.has(c.key)) throw badRequest(`Two fields use the key “${c.key}”`);
        seen.add(c.key);
        if ((c.type === 'select' || c.type === 'multiselect') && !c.options.length) throw badRequest(`${c.label}: give its choices`);
        if (c.type === 'master' && !c.master) throw badRequest(`${c.label}: choose the list it picks from`);
    }
    // A removed field that already has values is kept, switched off (values stay with the records).
    const removed = before.custom.filter((c) => !seen.has(c.key));
    const used = await usage(f, removed.map((c) => c.key));
    const custom: CustomField[] = [...input.custom, ...removed.filter((c) => used[c.key]).map((c) => ({ ...c, active: false }))];
    labelsSchema.parse(labels);
    await setSetting(f.settings.hidden, hidden, userId);
    await setSetting(f.settings.required, required, userId);
    await setSetting(f.settings.labels, labels, userId);
    await setSetting(f.settings.custom, custom, userId);
    await recordAudit({ action: 'form_setup', entity: 'form', entityId: null, changes: { form: f.key, hidden: hidden.length, required: required.length, renamed: Object.keys(labels).length, extra: custom.filter((c) => c.active).length } });
    return getForm(key);
};

/** What a form needs to draw itself: the school's names for fields and its active extra fields. */
export const formExtras = async (key: 'student' | 'staff', userId?: string) => {
    const f = FORMS[key];
    const s = await getSettings({ labels: f.settings.labels, custom: f.settings.custom });
    const access = userId ? await getUserAccess(userId) : null;
    return { labels: s.labels, custom: s.custom.filter((c) => c.active && canSee(c, access)) };
};

/** A record's extra field values, without the ones this person may not see. */
export const visibleValues = async (key: 'student' | 'staff', values: unknown, userId: string) => {
    const all = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
    const f = FORMS[key];
    const custom = await getSetting(f.settings.custom);
    const access = await getUserAccess(userId);
    const hidden = new Set(custom.filter((c) => !canSee(c, access)).map((c) => c.key));
    return Object.fromEntries(Object.entries(all).filter(([k]) => !hidden.has(k)));
};

const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks extra field values against the form's fields and returns what to save: the existing values
 * with the given ones on top (keys of switched-off fields are kept; unknown keys are dropped).
 * `creating`: every required field must have a value.
 */
export const checkCustom = async (key: 'student' | 'staff', input: Record<string, unknown> | undefined, existing: unknown, creating: boolean, userId?: string) => {
    // Only the fields this person sees can be given (and only those are required of them).
    const { custom } = await formExtras(key, userId);
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
    if (input === undefined && !creating) return null;
    const given = input ?? {};
    const issues: { field: string; message: string }[] = [];
    const masters: { field: string; master: string; ids: string[] }[] = [];
    for (const c of custom) {
        if (!(c.key in given)) continue;
        const raw = given[c.key];
        const empty = raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length);
        if (empty) {
            delete base[c.key];
            continue;
        }
        const field = `custom.${c.key}`;
        const bad = (message: string) => issues.push({ field, message });
        switch (c.type) {
            case 'text':
            case 'textarea': {
                const v = String(raw).trim();
                if (v.length > (c.type === 'text' ? 200 : 2000)) bad('is too long');
                else base[c.key] = v;
                break;
            }
            case 'number': {
                const n = Number(raw);
                if (!Number.isFinite(n)) bad('must be a number');
                else base[c.key] = n;
                break;
            }
            case 'date':
                if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(String(raw)))) bad('must be a date');
                else base[c.key] = String(raw);
                break;
            case 'boolean':
                base[c.key] = raw === true || raw === 'true' || raw === 'Yes' || raw === 'yes';
                break;
            case 'select':
                if (!c.options.includes(String(raw))) bad('is not one of its choices');
                else base[c.key] = String(raw);
                break;
            case 'multiselect': {
                const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean);
                if (list.some((x) => !c.options.includes(x))) bad('has a choice that is not in its list');
                else base[c.key] = [...new Set(list)];
                break;
            }
            case 'master':
                masters.push({ field, master: c.master ?? '', ids: [String(raw)] });
                base[c.key] = String(raw);
                break;
            case 'phone':
                if (!PHONE.test(String(raw).trim())) bad('is not a valid phone number');
                else base[c.key] = String(raw).trim();
                break;
            case 'email':
                if (!EMAIL.test(String(raw).trim())) bad('is not a valid email');
                else base[c.key] = String(raw).trim().toLowerCase();
                break;
        }
    }
    for (const m of masters) {
        const ok = await db.masterValue.count({ where: { id: { in: m.ids.filter((x) => z.uuid().safeParse(x).success) }, master: m.master } });
        if (ok !== m.ids.length) issues.push({ field: m.field, message: 'is not an option of its list' });
    }
    for (const c of custom) if (c.required && (base[c.key] === undefined || base[c.key] === null || base[c.key] === '')) issues.push({ field: `custom.${c.key}`, message: 'is required' });
    if (issues.length) {
        const name = (f: string) => custom.find((c) => `custom.${c.key}` === f)?.label ?? f;
        throw badRequest(issues.length === 1 ? `${name(issues[0].field)} ${issues[0].message}` : 'Some fields need attention', issues);
    }
    return base;
};

/** Extra field values as text (lists, Excel). */
export const customText = (c: CustomField, v: unknown, masterNames?: Map<string, string>) => {
    if (v === undefined || v === null || v === '') return '';
    if (c.type === 'boolean') return v ? 'Yes' : 'No';
    if (c.type === 'multiselect') return (v as string[]).join(', ');
    if (c.type === 'master') return masterNames?.get(String(v)) ?? '';
    return String(v);
};

/** For an Excel export: the school's field names, and a column per extra field of these records. */
export const exportExtras = async (key: 'student' | 'staff', ids: string[], userId?: string) => {
    const { labels, custom } = await formExtras(key, userId);
    if (!custom.length) return { labels, columns: [] };
    const rows = key === 'student' ? await db.student.findMany({ where: { id: { in: ids } }, select: { id: true, customFields: true } }) : await db.staff.findMany({ where: { id: { in: ids } }, select: { id: true, customFields: true } });
    const byId = new Map(rows.map((r) => [r.id, (r.customFields ?? {}) as Record<string, unknown>]));
    const masterIds = custom.filter((c) => c.type === 'master').flatMap((c) => rows.map((r) => byId.get(r.id)?.[c.key]).filter((v): v is string => typeof v === 'string'));
    const names = masterIds.length ? new Map((await db.masterValue.findMany({ where: { id: { in: masterIds } }, select: { id: true, name: true } })).map((m) => [m.id, m.name])) : new Map<string, string>();
    return { labels, columns: custom.map((c) => ({ header: c.label, width: 18, value: (r: { id: string }) => customText(c, byId.get(r.id)?.[c.key], names) })) };
};

// ─── Excel import ────────────────────────────────────────────────────────────

const ADDRESS_COLUMNS = ['addressLine', 'stateId', 'districtId', 'cityId', 'pinCode'];
const fieldOfColumn = (col: string) => (ADDRESS_COLUMNS.includes(col) ? 'address' : col);
const IMPORT_TYPE: Record<string, ImportColumn['type']> = { text: 'text', textarea: 'text', phone: 'text', email: 'email', number: 'number', date: 'date', boolean: 'choice', select: 'choice', multiselect: 'list', master: 'choice' };

/**
 * The import template follows the Form Builder: columns of hidden fields are left out, renamed
 * fields carry the school's name, and each extra field gets a column (prefixed "custom__").
 * `toCustom` turns a row's values into the extra fields to save.
 */
export const importExtras = async (key: 'student' | 'staff') => {
    const f = FORMS[key];
    const s = await getSettings({ hidden: f.settings.hidden, labels: f.settings.labels, custom: f.settings.custom });
    const custom = s.custom.filter((c) => c.active);
    const masters = new Map<string, { id: string; name: string }[]>();
    for (const c of custom) if (c.type === 'master' && c.master && !masters.has(c.master)) masters.set(c.master, await db.masterValue.findMany({ where: { master: c.master, isActive: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
    const adjust = (columns: ImportColumn[]): ImportColumn[] => [
        ...columns.filter((c) => !s.hidden.includes(fieldOfColumn(c.key))).map((c) => (s.labels[c.key] ? { ...c, header: s.labels[c.key] } : c)),
        ...custom.map((c) => ({
            key: `custom__${c.key}`,
            header: c.label,
            type: IMPORT_TYPE[c.type],
            required: c.required,
            ...(c.type === 'boolean' ? { choices: ['Yes', 'No'] } : c.type === 'select' || c.type === 'multiselect' ? { choices: c.options } : c.type === 'master' ? { choices: (masters.get(c.master ?? '') ?? []).map((m) => m.name) } : {}),
            ...(c.type === 'text' ? { max: 200 } : c.type === 'textarea' ? { max: 2000 } : {}),
            ...(c.help ? { help: c.help } : {}),
        })),
    ];
    const toCustom = (values: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const c of custom) {
            const v = values[`custom__${c.key}`];
            if (v === undefined || v === null || v === '') continue;
            if (c.type === 'date') out[c.key] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
            else if (c.type === 'master') out[c.key] = (masters.get(c.master ?? '') ?? []).find((m) => m.name.toLowerCase() === String(v).toLowerCase())?.id ?? String(v);
            else if (c.type === 'boolean') out[c.key] = String(v) === 'Yes';
            else out[c.key] = v;
        }
        return out;
    };
    return { adjust, toCustom };
};
