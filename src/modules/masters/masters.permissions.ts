import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { auditModel, db } from '../../core/db';
import type { ImportColumn, ParsedRow } from '../../core/excel';
import { registerImport } from '../imports/import.service';
import { listMasters, MasterDef } from './masters.registry';
import { checkExtra, cleanName, createValue, managePermission, masterDef, optionLabels, updateValue } from './masters.service';
import './shared/location.masters';
import './shared/people.masters';

registerPermissions({ key: 'masters', label: 'Masters', order: 20 }, [
    { resource: 'masters', action: 'view', label: 'See the master lists (Configuration → Masters)' },
    { resource: 'masters', action: 'manage', label: 'Add, change and remove options of the master lists (states, religions, banks…)' },
]);

registerMenuGroup({ key: 'configuration', label: 'Configuration', order: 70 });
registerMenuItems([{ key: 'masters', label: 'Masters', icon: 'list_alt', href: '/masters', group: 'configuration', order: 90, permission: 'masters.view' }]);

// Every change to an option is kept with old and new values (shown in its History).
auditModel('MasterValue', 'master_value');

// ─── Excel import, one per list ──────────────────────────────────────────────

interface ImportCtx {
    /** "<parentId>|<name>" and "code:<code>" (lower case) → existing option id */
    existing: Map<string, string>;
    parents: Map<string, string>;
    seen: Set<string>;
}

const YES_NO = ['Yes', 'No'];

const columnsFor = async (def: MasterDef): Promise<ImportColumn[]> => {
    const parent = def.parent ? masterDef(def.parent) : null;
    return [
        { key: 'name', header: 'Name', type: 'text', required: true, max: 120, help: `The ${def.label.toLowerCase()}. A row with the same name${parent ? ` and ${parent.label.toLowerCase()}` : ''} as an existing option updates it.`, example: '' },
        ...(def.code !== 'none'
            ? [{ key: 'code', header: 'Code', type: 'text' as const, required: def.code === 'required', max: 20, help: 'A short code (letters, numbers, dots, dashes).' }]
            : []),
        ...(parent
            ? [{ key: 'parent', header: parent.label, type: 'choice' as const, required: true, choices: (await optionLabels(parent.key)).map((o) => o.label), help: `The ${parent.label.toLowerCase()} it belongs to.` }]
            : []),
        ...(def.fields ?? []).map((f): ImportColumn => ({
            key: `extra.${f.key}`,
            header: f.label,
            type: f.type === 'number' ? 'number' : f.type === 'boolean' ? 'choice' : 'text',
            required: f.required,
            max: f.max,
            choices: f.type === 'boolean' ? YES_NO : undefined,
            help: f.help,
            example: f.example,
        })),
        { key: 'active', header: 'Active', type: 'choice', choices: YES_NO, help: 'No = kept on old records but can’t be chosen any more. Empty = Yes.', example: 'Yes' },
    ];
};

const extraOf = (def: MasterDef, row: ParsedRow) =>
    Object.fromEntries(
        (def.fields ?? []).map((f) => {
            const v = row.values[`extra.${f.key}`];
            return [f.key, f.type === 'boolean' && v !== null ? v === 'Yes' : v];
        })
    );

const registerMasterImport = (def: MasterDef) =>
    registerImport<ImportCtx>({
        kind: `master-${def.key}`,
        label: def.plural,
        permission: managePermission(def),
        columns: () => columnsFor(def),
        prepare: async () => {
            const rows = await db.masterValue.findMany({ where: { master: def.key }, select: { id: true, name: true, code: true, parentId: true } });
            const existing = new Map<string, string>();
            for (const r of rows) {
                existing.set(`${r.parentId ?? ''}|${r.name.toLowerCase()}`, r.id);
                if (r.code) existing.set(`code:${r.code.toLowerCase()}`, r.id);
            }
            const parents = new Map(def.parent ? (await optionLabels(def.parent)).map((o) => [o.label.toLowerCase(), o.id]) : []);
            return { existing, parents, seen: new Set() };
        },
        check: (row, ctx) => {
            const v = row.values;
            const parentId = def.parent && v.parent ? ctx.parents.get(String(v.parent).toLowerCase()) : undefined;
            const key = `${parentId ?? ''}|${cleanName(String(v.name ?? '')).toLowerCase()}`;
            if (ctx.seen.has(key)) row.issues.push({ field: 'Name', message: 'appears twice in the file' });
            ctx.seen.add(key);
            if (v.code && !/^[A-Za-z0-9._/-]+$/.test(String(v.code))) row.issues.push({ field: 'Code', message: 'use letters, numbers, dots, dashes or slashes' });
            if (v.code) {
                const owner = ctx.existing.get(`code:${String(v.code).toLowerCase()}`);
                if (owner && owner !== ctx.existing.get(key)) row.issues.push({ field: 'Code', message: 'is already used by another option' });
            }
            for (const issue of checkExtra(def, extraOf(def, row)).issues) {
                const field = def.fields?.find((f) => `extra.${f.key}` === issue.field);
                row.issues.push({ field: field?.label ?? issue.field, message: issue.message });
            }
        },
        importRow: async (row, ctx) => {
            const v = row.values;
            const parentId = def.parent ? ctx.parents.get(String(v.parent).toLowerCase()) ?? null : null;
            const name = cleanName(String(v.name));
            const id = ctx.existing.get(`${parentId ?? ''}|${name.toLowerCase()}`);
            const input = {
                name,
                ...(def.code !== 'none' ? { code: (v.code as string | null) ?? null } : {}),
                parentId,
                extra: extraOf(def, row),
                isActive: v.active !== 'No',
            };
            const saved = id ? await updateValue(def.key, id, input) : await createValue(def.key, input);
            ctx.existing.set(`${parentId ?? ''}|${name.toLowerCase()}`, saved.id);
            if (saved.code) ctx.existing.set(`code:${saved.code.toLowerCase()}`, saved.id);
            return {
                Name: saved.name,
                ...(def.parent ? { [masterDef(def.parent).label]: saved.ancestors[saved.ancestors.length - 1]?.name ?? '' } : {}),
                Result: id ? 'Updated' : 'Added',
            };
        },
    });

/** Called once every module has declared its lists (end of modules/registry.ts). */
export const registerMasterImports = () => listMasters().forEach(registerMasterImport);
