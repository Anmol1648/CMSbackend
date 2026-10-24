import { z } from 'zod';
import { defineSetting } from '../../core/settings';
import { defineMaster, defineMasterGroup } from '../masters/masters.registry';

/**
 * System Settings → Alerts: the channels and the rules of sending. Each alert's own on/off, text and
 * channels are on Alerts → Built-in Alerts; who may send or see what is in Roles & Permissions.
 * Provider keys are kept encrypted (hidden settings, entered on Alerts → Channels).
 */

const G = 'Alerts';
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour time like 08:00');
const bool = (key: string, label: string, def: boolean, help?: string) => defineSetting<boolean>({ key, group: G, label, help, type: 'boolean', default: def, schema: z.boolean() });
const num = (key: string, label: string, def: number, min: number, max: number, help?: string) =>
    defineSetting<number>({ key, group: G, label, help, type: 'number', default: def, schema: z.number().int().min(min).max(max) });
const text = (key: string, label: string, def: string, schema: z.ZodType<string>, help?: string) => defineSetting<string>({ key, group: G, label, help, type: 'text', default: def, schema });
const secret = (key: string) => defineSetting<string>({ key, group: G, label: key, type: 'text', default: '', schema: z.string().max(2000), hidden: true });

export const CHANNELS = ['in_app', 'email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { in_app: 'In-app', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

export const ALERTS = {
    inApp: bool('alerts.in_app', 'In-app notifications (the bell)', true),
    email: bool('alerts.email', 'Email', true, 'Sent from the school’s mail account (SMTP).'),
    sms: bool('alerts.sms', 'SMS', false, 'Needs an SMS provider account: enter its keys on Alerts → Channels.'),
    smsProvider: defineSetting<string>({
        key: 'alerts.sms_provider',
        group: G,
        label: 'SMS provider',
        type: 'select',
        default: 'msg91',
        schema: z.enum(['msg91', 'twilio', 'fast2sms']),
        options: [
            { value: 'msg91', label: 'MSG91' },
            { value: 'twilio', label: 'Twilio' },
            { value: 'fast2sms', label: 'Fast2SMS' },
        ],
    }),
    smsSender: text('alerts.sms_sender', 'SMS sender ID (6 letters, approved on DLT) or number', '', z.string().trim().max(20)),
    whatsapp: bool('alerts.whatsapp', 'WhatsApp', false, 'Needs a WhatsApp Business account: enter its keys on Alerts → Channels.'),
    whatsappProvider: defineSetting<string>({
        key: 'alerts.whatsapp_provider',
        group: G,
        label: 'WhatsApp provider',
        type: 'select',
        default: 'meta',
        schema: z.enum(['meta', 'gupshup']),
        options: [
            { value: 'meta', label: 'Meta (WhatsApp Cloud API)' },
            { value: 'gupshup', label: 'Gupshup' },
        ],
    }),
    whatsappNumber: text('alerts.whatsapp_number', 'WhatsApp business number (with country code)', '', z.string().trim().max(20)),
    fallback: defineSetting<string[]>({
        key: 'alerts.fallback',
        group: G,
        label: 'When a person can’t be reached on a channel, try',
        help: 'In this order, e.g. a parent without a login gets the email instead of the in-app notice.',
        type: 'multiselect',
        default: ['in_app', 'email', 'sms'],
        schema: z.array(z.enum(CHANNELS)).max(4),
        options: CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] })),
    }),
    quietFrom: text('alerts.quiet_from', 'Quiet hours for SMS and WhatsApp: from', '21:00', time, 'Messages in quiet hours wait until they end. Email and in-app still go.'),
    quietTo: text('alerts.quiet_to', 'Quiet hours: until', '07:00', time),
    dailyTime: text('alerts.daily_time', 'Time of day the daily alerts go (fee due, overdue, follow-ups…)', '08:00', time),
    absentDays: num('alerts.absent_days', 'Alert parents and the class teacher after this many days absent in a row', 3, 2, 30),
    feeDueDays: num('alerts.fee_due_days', 'Remind parents this many days before an instalment is due', 3, 1, 30),
    overdueEvery: num('alerts.overdue_every', 'Remind parents of overdue fees every this many days', 7, 1, 60),
    checkInBy: text('alerts.check_in_by', 'Remind staff who haven’t checked in by', '09:30', time),
    maxPerDay: num('alerts.max_per_day', 'At most this many copies of the same alert to one person in a day', 1, 1, 10),
    keepNotifications: num('alerts.keep_notifications', 'Keep in-app notifications for this many days', 90, 7, 730),
    keepLog: num('alerts.keep_log', 'Keep the alert log for this many days', 365, 30, 1825),
    retries: num('alerts.retries', 'Try a failed message again this many times', 3, 0, 10),
    perMinute: num('alerts.per_minute', 'Send at most this many emails a minute', 60, 1, 1000, 'So the mail provider doesn’t block the school for sending too fast.'),
    bounceLimit: num('alerts.bounce_limit', 'Flag an email address after this many failed messages', 3, 1, 20),
    customMax: num('alerts.custom_max', 'At most this many custom alerts (made from reports)', 30, 1, 200),
    customMaxPeople: num('alerts.custom_max_people', 'A custom alert reaches at most this many people in one run', 2000, 10, 20000, 'More rows than this and the run stops, so a wrong filter can’t message the whole school.'),
    toast: bool('alerts.toast', 'Pop up important notifications on screen', true),
    refreshSeconds: num('alerts.refresh_seconds', 'Check for new notifications every this many seconds', 30, 10, 600),
    // Encrypted provider keys (Alerts → Channels).
    smsKey: secret('alerts.sms_key'),
    smsAccount: secret('alerts.sms_account'),
    smsTemplate: secret('alerts.sms_template'),
    whatsappKey: secret('alerts.whatsapp_key'),
    whatsappAccount: secret('alerts.whatsapp_account'),
    whatsappTemplate: secret('alerts.whatsapp_template'),
};

defineMasterGroup({ key: 'alerts', label: 'Alerts & Messages', order: 14 });
defineMaster({
    key: 'message_category',
    label: 'Message category',
    plural: 'Message categories',
    description: 'Kinds of messages written on Compose and of saved templates, for finding them later.',
    group: 'alerts',
    order: 10,
    code: 'none',
    ordering: 'manual',
    seed: [{ name: 'General' }, { name: 'Emergency' }, { name: 'PTM' }, { name: 'Fees' }, { name: 'Exams' }, { name: 'Holiday' }, { name: 'Event' }],
});
defineMaster({
    key: 'notification_type',
    label: 'Notification type',
    plural: 'Notification types',
    description: 'The kinds of notifications (the code is used by the software; the name and icon can be changed). People choose their channels per type on My Profile.',
    group: 'alerts',
    order: 20,
    code: 'required',
    ordering: 'manual',
    fields: [{ key: 'icon', label: 'Icon (Material Symbols name)', type: 'text', max: 40, example: 'event_busy' }],
    seed: [
        { name: 'Attendance', code: 'attendance', extra: { icon: 'event_busy' } },
        { name: 'Fees', code: 'fees', extra: { icon: 'payments' } },
        { name: 'Exams', code: 'exams', extra: { icon: 'grading' } },
        { name: 'Leave', code: 'leave', extra: { icon: 'flight_takeoff' } },
        { name: 'Notices', code: 'notices', extra: { icon: 'campaign' } },
        { name: 'Messages', code: 'messages', extra: { icon: 'mail' } },
        { name: 'Admissions', code: 'admissions', extra: { icon: 'person_add' } },
        { name: 'Homework', code: 'homework', extra: { icon: 'menu_book' } },
        { name: 'Transport', code: 'transport', extra: { icon: 'directions_bus' } },
        { name: 'Library', code: 'library', extra: { icon: 'local_library' } },
        { name: 'Students', code: 'students', extra: { icon: 'school' } },
        { name: 'Staff', code: 'staff', extra: { icon: 'badge' } },
        { name: 'Assets', code: 'assets', extra: { icon: 'inventory_2' } },
        { name: 'Inventory', code: 'inventory', extra: { icon: 'inventory' } },
    ],
});
defineMaster({
    key: 'alert_priority',
    label: 'Priority',
    plural: 'Priorities',
    description: 'How important a notification is: whether it stays on top until read and pops up on screen.',
    group: 'alerts',
    order: 30,
    code: 'required',
    ordering: 'manual',
    fields: [
        { key: 'pinned', label: 'Stays on top until read', type: 'boolean' },
        { key: 'toast', label: 'Pops up on screen', type: 'boolean' },
    ],
    seed: [
        { name: 'Normal', code: 'normal', extra: { pinned: false, toast: false } },
        { name: 'Important', code: 'important', extra: { pinned: true, toast: true } },
        { name: 'Emergency', code: 'emergency', extra: { pinned: true, toast: true } },
    ],
});
