import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';
import { DEFAULT_ROLES } from '../tenants/default-roles';

/**
 * System Settings → Complaints (reopening, closing, escalation, ratings), and its lists (Masters →
 * Complaints): categories with who handles them and how fast, and reply snippets. Who raises,
 * handles or manages complaints is in Roles & Permissions (complaint.*).
 */

const G = 'Complaints';
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });

export const COMPLAINTS = {
    ticketPrefix: defineSetting<string>({ key: 'complaints.ticket_prefix', group: G, label: 'Ticket numbers start with', help: 'Then the year and a running number, e.g. CMP-2026-0042.', type: 'text', default: 'CMP-', schema: z.string().trim().max(10) }),
    reopenDays: num('complaints.reopen_days', 'The person who raised it can reopen a resolved complaint for this many days', 7, 0, 60),
    autoCloseDays: num('complaints.auto_close_days', 'A resolved complaint closes by itself after this many days (0 = never)', 7, 0, 60),
    escalateAfterHours: num('complaints.escalate_after_hours', 'Escalate again this many hours after the first escalation if still not done', 24, 1, 720),
    ratings: bool('complaints.ratings', 'The person who raised it can rate how it was handled (1–5 stars)', true),
    maxFiles: num('complaints.max_files', 'Photos or files with a complaint (or a reply)', 3, 0, 10),
    defaultResponseHours: num('complaints.default_response_hours', 'Reply within (hours), when the category doesn’t say', 24, 1, 720),
    defaultResolveHours: num('complaints.default_resolve_hours', 'Resolve within (hours), when the category doesn’t say', 72, 1, 2160),
};

/** Roles a category can be routed to, plus the student's class teacher. */
export const HANDLER_OPTIONS = [{ value: 'class_teacher', label: 'The student’s class teacher' }, ...DEFAULT_ROLES.filter((r) => !['student', 'guardian', 'super-admin'].includes(r.slug)).map((r) => ({ value: r.slug, label: r.name }))];

defineMasterGroup({ key: 'complaints', label: 'Complaints', order: 21 });

defineMaster({
    key: 'complaint_category',
    label: 'Complaint category',
    plural: 'Complaint categories',
    description: 'What complaints are about, who gets them first, and how fast they must be answered and resolved.',
    group: 'complaints',
    order: 10,
    code: 'none',
    ordering: 'manual',
    fields: [
        { key: 'handler', label: 'Goes to', type: 'select', options: HANDLER_OPTIONS },
        { key: 'response_hours', label: 'Reply within (hours)', type: 'number' },
        { key: 'resolve_hours', label: 'Resolve within (hours)', type: 'number' },
        { key: 'urgent', label: 'Always urgent (the principal is told at once)', type: 'boolean' },
        { key: 'anonymous', label: 'Can be raised anonymously', type: 'boolean' },
    ],
    seed: [
        { name: 'Academics / teaching', extra: { handler: 'class_teacher', response_hours: 24, resolve_hours: 72, urgent: false, anonymous: false } },
        { name: 'Homework / exams', extra: { handler: 'class_teacher', response_hours: 24, resolve_hours: 72, urgent: false, anonymous: false } },
        { name: 'Transport / bus', extra: { handler: 'office-staff', response_hours: 12, resolve_hours: 48, urgent: false, anonymous: false } },
        { name: 'Fees / payments', extra: { handler: 'accountant', response_hours: 24, resolve_hours: 72, urgent: false, anonymous: false } },
        { name: 'Staff behaviour', extra: { handler: 'principal', response_hours: 24, resolve_hours: 120, urgent: false, anonymous: true } },
        { name: 'Bullying / safety', extra: { handler: 'principal', response_hours: 4, resolve_hours: 48, urgent: true, anonymous: true } },
        { name: 'Building / furniture / facilities', extra: { handler: 'school-admin', response_hours: 48, resolve_hours: 240, urgent: false, anonymous: false } },
        { name: 'Drinking water / toilets / hygiene', extra: { handler: 'school-admin', response_hours: 12, resolve_hours: 72, urgent: false, anonymous: true } },
        { name: 'App / website / login', extra: { handler: 'school-admin', response_hours: 24, resolve_hours: 72, urgent: false, anonymous: false } },
        { name: 'Other', extra: { handler: 'office-staff', response_hours: 48, resolve_hours: 168, urgent: false, anonymous: false } },
    ],
});

defineMaster({
    key: 'complaint_snippet',
    label: 'Complaint reply',
    plural: 'Complaint replies',
    description: 'Ready-made replies handlers can insert and edit.',
    group: 'complaints',
    order: 20,
    code: 'none',
    ordering: 'manual',
    seed: [
        'Thank you for telling us. We are looking into it and will update you soon.',
        'We have spoken to the class teacher; they will contact you.',
        'The issue has been fixed. Please let us know if it happens again.',
        'Could you share a few more details (date, time, class) so we can act on this?',
        'We have arranged a meeting with the principal; the office will call you with a time.',
    ].map((name) => ({ name })),
});
