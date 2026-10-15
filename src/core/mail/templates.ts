/**
 * Email template registry. Each module declares the emails it sends: fields ({{placeholders}}) with an
 * example value, which fields are required, and the default subject and text. Schools may reword
 * them (Setup → Email Templates); every email is drawn in the same school-branded layout.
 */

export interface TemplatePlaceholder {
    key: string;
    label: string;
    /** Shown in previews and test emails. */
    example: string;
    /** 'code' = drawn as a large boxed value (reset codes, one-time passwords). */
    style?: 'code';
}

export interface EmailTemplateDef {
    key: string;
    label: string;
    description: string;
    placeholders: TemplatePlaceholder[];
    /** Placeholders the wording must keep (e.g. the reset code). */
    required: string[];
    subject: string;
    body: string;
}

/** Available in every template. */
export const COMMON_PLACEHOLDERS: TemplatePlaceholder[] = [
    { key: 'school', label: 'School name (short)', example: 'KV Joshimath' },
    { key: 'schoolFullName', label: 'School name (full)', example: 'PM SHRI Kendriya Vidyalaya Joshimath' },
];

const registry = new Map<string, EmailTemplateDef>();

export const registerEmailTemplate = (def: EmailTemplateDef) => {
    if (registry.has(def.key)) throw new Error(`Email template "${def.key}" is registered twice`);
    for (const r of def.required) if (!def.placeholders.some((p) => p.key === r)) throw new Error(`${def.key}: required {{${r}}} is not a placeholder`);
    registry.set(def.key, def);
    return def;
};

export const listEmailTemplateDefs = () => [...registry.values()];
export const findEmailTemplateDef = (key: string) => registry.get(key);

export const placeholdersOf = (def: EmailTemplateDef) => [...def.placeholders, ...COMMON_PLACEHOLDERS];

/** {{names}} used in a text. */
export const usedPlaceholders = (text: string) => [...text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]);

/** Problems with a school's wording: missing required fields, unknown fields. */
export const checkTemplateText = (def: EmailTemplateDef, subject: string, body: string) => {
    const issues: { field: string; message: string }[] = [];
    const known = new Set(placeholdersOf(def).map((p) => p.key));
    const used = new Set([...usedPlaceholders(subject), ...usedPlaceholders(body)]);
    for (const r of def.required) if (!used.has(r)) issues.push({ field: 'body', message: `must contain {{${r}}}` });
    for (const u of used) if (!known.has(u)) issues.push({ field: usedPlaceholders(subject).includes(u) ? 'subject' : 'body', message: `{{${u}}} is not a field of this email` });
    return issues;
};
