import { z } from 'zod';

/**
 * A school's own field on a form (Setup → Form Builder): its type, options, whether it is required,
 * and the section it sits in. Its key never changes once made, so saved values keep their meaning
 * when the label is reworded.
 */

export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect', 'master', 'phone', 'email'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const customFieldSchema = z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'must be lowercase letters, numbers and _'),
    label: z.string().trim().min(1, 'is required').max(60),
    type: z.enum(FIELD_TYPES),
    /** select / multiselect: the choices. */
    options: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
    /** master: the Masters list it picks from. */
    master: z.string().max(60).nullable().default(null),
    required: z.boolean().default(false),
    help: z.string().trim().max(200).nullable().default(null),
    /** The heading it appears under (empty = "Other details"). */
    section: z.string().trim().max(60).nullable().default(null),
    /** Switched off: hidden from forms, values kept. */
    active: z.boolean().default(true),
    /** Only these roles see and fill it (empty = everyone who sees the record). */
    visibleTo: z.array(z.uuid()).max(50).default([]),
    /** Admission enquiry: also on the online form parents fill. */
    onPublicForm: z.boolean().default(false),
});
export type CustomField = z.infer<typeof customFieldSchema>;

export const customFieldsSchema = z.array(customFieldSchema).max(60);
export const labelsSchema = z.record(z.string().max(40), z.string().trim().min(1).max(60));
