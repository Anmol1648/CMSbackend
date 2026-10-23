import type { Channel } from './alerts.settings';

/**
 * Built-in alerts. Each module declares the alerts it raises (in its own *.alerts.ts): who can get
 * them, the fields the wording can use, and the defaults. The school changes them on
 * Alerts → Built-in Alerts (on/off, channels, who gets it, wording); the module only calls raise().
 */

export interface AlertField {
    key: string;
    label: string;
    example: string;
}

export interface AlertDef {
    key: string;
    label: string;
    description: string;
    /** Notification type code (Masters → Notification types). */
    type: string;
    /** "Instant" (when it happens) or "Daily at the alerts time". */
    when: 'instant' | 'daily';
    /** Who can get it; the school ticks which. */
    recipients: { key: string; label: string }[];
    fields: AlertField[];
    defaults: {
        enabled: boolean;
        channels: Channel[];
        recipients: string[];
        priority?: string;
        required?: boolean;
        subject: string;
        body: string;
        shortText: string;
    };
    /** The screen the in-app notification opens, per recipient kind (e.g. parent → /my-attendance). */
    link?: Partial<Record<string, string>> | string;
}

/** Placeholders every alert has. */
export const COMMON_FIELDS: AlertField[] = [
    { key: 'name', label: 'The person’s name', example: 'Mahesh Nautiyal' },
    { key: 'school', label: 'School name', example: 'KV Joshimath' },
];

const registry = new Map<string, AlertDef>();

export const defineAlert = (def: AlertDef) => {
    if (registry.has(def.key)) throw new Error(`Alert "${def.key}" is defined twice`);
    for (const r of def.defaults.recipients) if (!def.recipients.some((x) => x.key === r)) throw new Error(`${def.key}: default recipient "${r}" is not one of its recipients`);
    registry.set(def.key, def);
    return def;
};

export const listAlertDefs = () => [...registry.values()];
export const findAlertDef = (key: string) => registry.get(key);
