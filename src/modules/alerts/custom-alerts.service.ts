import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId, runAsSystem, runAsTenant } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { logger } from '../../core/logger';
import { currentYear } from '../academic/years.service';
import { minutesIST, todayIST } from '../attendance/attendance.settings';
import { alertReports, rowsForAlert } from '../reports/reports.service';
import type { ReportColumn } from '../reports/reports.registry';
import { ALERTS, CHANNELS, Channel } from './alerts.settings';
import { deliver, fill } from './deliver';
import { parentsOf, Recipient, sectionsOfStudents, staffOf, studentsOf, usersOf } from './recipients';
import { fmtDate, rupees } from './format';
import { onQueuePass } from './queue';

/**
 * Custom alerts (Alerts → Custom Alerts): a report the school picks (its rows are students or staff),
 * its filters, who gets told, when (daily / weekly / monthly at a time), the wording. Each run uses
 * the report as the person who made the alert, so it never reaches more than they may see; a person
 * isn't told again about the same row within "don't repeat" days.
 */

/** Told about their own row (one message each); the rest get one list. */
const PER_ROW = ['parent', 'student', 'staff'] as const;
const DAY = 86_400_000;

export const customSchema = z.strictObject({
    name: z.string().trim().min(1, 'is required').max(100),
    reportKey: z.string().trim().min(1, 'choose a report').max(100),
    filters: z.record(z.string(), z.string().max(100)).default({}),
    sendTo: z.array(z.string().trim().max(60)).min(1, 'choose who gets it').max(20),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    day: z.number().int().min(1).max(28).nullable().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour time like 08:00'),
    channels: z.array(z.enum(CHANNELS)).min(1, 'choose at least one').max(4),
    type: z.string().trim().min(1).max(40).default('messages'),
    priority: z.string().trim().max(30).default('normal'),
    subject: z.string().trim().min(1, 'is required').max(200),
    body: z.string().trim().min(1, 'is required').max(5000),
    shortText: z.string().trim().max(480).nullable().optional(),
    summarySubject: z.string().trim().min(1, 'is required').max(200).default('{{alert}}: {{count}}'),
    summaryBody: z.string().trim().min(1, 'is required').max(5000).default('{{list}}'),
    repeatDays: z.number().int().min(0).max(365),
    enabled: z.boolean(),
});
export type CustomInput = z.infer<typeof customSchema>;

const show = (c: Pick<ReportColumn, 'type'>, v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'money' && typeof v === 'number') return rupees(v);
    if (c.type === 'date' && typeof v === 'string') return fmtDate(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
    return String(v);
};
const rowVars = (columns: ReportColumn[], row: Record<string, unknown>) => ({ ...Object.fromEntries(columns.map((c) => [c.key, show(c, row[c.key])])), ...(row.groupLabel ? { group: String(row.groupLabel) } : {}) });
const rowLine = (columns: ReportColumn[], row: Record<string, unknown>) => [row.groupLabel ? String(row.groupLabel) : null, ...columns.map((c) => show(c, row[c.key]))].filter(Boolean).join(' · ');

const schoolName = async () => {
    const s = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } });
    return s?.shortName ?? s?.legalName ?? '';
};

/** The reports a person may use, with the people they are about. */
export const customOptions = (userId: string) => alertReports(userId);

const checkInput = async (input: CustomInput, userId: string) => {
    const reports = await alertReports(userId);
    const r = reports.find((x) => x.key === input.reportKey);
    if (!r) throw badRequest('Choose a report from the list', [{ field: 'reportKey', message: 'is not a report you can use' }]);
    const allowed = r.about === 'student' ? ['parent', 'student', 'class_teacher'] : ['staff'];
    const bad = input.sendTo.filter((s) => !allowed.includes(s) && !/^role:[0-9a-f-]{36}$/.test(s));
    if (bad.length) throw badRequest('Choose who gets it from the list', [{ field: 'sendTo', message: 'is not valid for this report' }]);
    if (input.frequency !== 'daily' && !input.day) throw badRequest(input.frequency === 'weekly' ? 'Choose the day of the week' : 'Choose the day of the month', [{ field: 'day', message: 'is required' }]);
    if (input.frequency === 'weekly' && input.day! > 7) throw badRequest('Choose a day of the week', [{ field: 'day', message: 'must be 1 (Monday) to 7 (Sunday)' }]);
    const known = new Set(['name', 'school', 'alert', 'group', ...r.columns.map((c) => c.key)]);
    const issues: { field: string; message: string }[] = [];
    for (const [field, text] of Object.entries({ subject: input.subject, body: input.body, shortText: input.shortText ?? '' }))
        for (const m of text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g)) if (!known.has(m[1])) issues.push({ field, message: `{{${m[1]}}} is not a column of this report` });
    if (issues.length) throw badRequest('Use only the fields listed', issues);
    return r;
};

const present = async (c: Prisma.CustomAlertGetPayload<object>) => {
    const reports = new Map((await alertReports(c.createdBy ?? '')).map((r) => [r.key, r]));
    const roles = new Map((await db.role.findMany({ select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    const r = reports.get(c.reportKey);
    return {
        ...c,
        report: r?.label ?? c.reportKey,
        about: r?.about ?? null,
        sendToLabels: c.sendTo.map((s) => (s === 'parent' ? 'Parents' : s === 'student' ? 'Students' : s === 'staff' ? 'The staff member' : s === 'class_teacher' ? 'Class teacher (a list)' : `${roles.get(s.slice(5)) ?? 'Role'} (a list)`)),
    };
};

export const listCustom = async () => Promise.all((await db.customAlert.findMany({ orderBy: { createdAt: 'asc' } })).map(present));
export const getCustom = async (id: string) => {
    const c = await db.customAlert.findFirst({ where: { id } });
    if (!c) throw notFound('Alert not found');
    return present(c);
};

export const saveCustom = async (id: string | null, input: CustomInput, userId: string) => {
    await checkInput(input, userId);
    if (!id) {
        const { max } = await getSettings({ max: ALERTS.customMax });
        if ((await db.customAlert.count()) >= max) throw badRequest(`At most ${max} custom alerts (System Settings → Alerts)`);
    }
    const data = { ...input, day: input.frequency === 'daily' ? null : (input.day ?? null), shortText: input.shortText ?? null, filters: input.filters as Prisma.InputJsonValue, updatedBy: userId };
    // The person who saves it is who the report runs as.
    const c = id ? await db.customAlert.update({ where: { id }, data: { ...data, createdBy: userId } }) : await db.customAlert.create({ data: { ...data, tenantId: getTenantId()!, createdBy: userId } });
    await recordAudit({ action: id ? 'custom_alert_changed' : 'custom_alert_added', entity: 'custom_alert', entityId: c.id, changes: { name: c.name, report: c.reportKey, enabled: c.enabled } });
    return getCustom(c.id);
};

export const deleteCustom = async (id: string) => {
    const c = await db.customAlert.findFirst({ where: { id } });
    if (!c) throw notFound('Alert not found');
    await db.customAlert.delete({ where: { id } });
    await recordAudit({ action: 'custom_alert_deleted', entity: 'custom_alert', entityId: id, changes: { name: c.name } });
    return { id, deleted: true };
};

// ─── Running ─────────────────────────────────────────────────────────────────

type Alert = Pick<Prisma.CustomAlertGetPayload<object>, 'id' | 'name' | 'reportKey' | 'filters' | 'sendTo' | 'channels' | 'type' | 'priority' | 'subject' | 'body' | 'shortText' | 'summarySubject' | 'summaryBody' | 'repeatDays' | 'createdBy'>;

/** Rows not told about within "don't repeat" days. */
const freshRows = async (c: Alert, rows: Record<string, unknown>[], idKey: 'studentId' | 'staffId') => {
    if (c.repeatDays <= 0) return rows;
    const recent = await db.messageDelivery.findMany({ where: { alertKey: `custom:${c.id}`, createdAt: { gte: new Date(Date.now() - c.repeatDays * DAY) }, status: { in: ['sent', 'queued', 'sending'] } }, select: { dedupeKey: true } });
    const told = new Set(recent.map((d) => d.dedupeKey?.split(':')[2]).filter(Boolean));
    return rows.filter((r) => !told.has(String(r[idKey])));
};

/** Class teachers of the students in these rows, with the rows of their own students. */
const byClassTeacher = async (rows: Record<string, unknown>[]) => {
    const year = await currentYear();
    if (!year) return new Map<string, Record<string, unknown>[]>();
    const ids = rows.map((r) => String(r.studentId));
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: ids } }, select: { studentId: true, section: { select: { classTeacherId: true } } } });
    const ct = new Map(enrol.map((e) => [e.studentId, e.section.classTeacherId]));
    const out = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
        const t = ct.get(String(r.studentId));
        if (t) out.set(t, [...(out.get(t) ?? []), r]);
    }
    return out;
};

const runAlert = async (c: Alert, dryRun: boolean) => {
    if (!c.createdBy) throw new Error('Nobody owns this alert; save it again');
    const { def, rows } = await rowsForAlert(c.reportKey, c.filters as Record<string, unknown>, c.createdBy);
    const idKey = def.about === 'student' ? 'studentId' : 'staffId';
    const withId = rows.filter((r) => r[idKey]);
    const fresh = await freshRows(c, withId, idKey);
    const { maxPeople } = await getSettings({ maxPeople: ALERTS.customMaxPeople });
    if (fresh.length > maxPeople) throw badRequest(`The report has ${fresh.length} rows, more than ${maxPeople} (System Settings → Alerts). Narrow the filters.`);
    const school = await schoolName();
    const today = todayIST();
    const base = { type: c.type, priority: c.priority, channels: c.channels as Channel[], ignoreDailyLimit: true, alertKey: `custom:${c.id}` };
    const perRow = c.sendTo.filter((s) => (PER_ROW as readonly string[]).includes(s));
    const summaryTo = c.sendTo.filter((s) => !(PER_ROW as readonly string[]).includes(s));
    const sample = fresh[0] ? { subject: fill(c.subject, { ...rowVars(def.columns, fresh[0]), alert: c.name, school, name: '…' }), body: fill(c.body, { ...rowVars(def.columns, fresh[0]), alert: c.name, school, name: '…' }) } : null;
    const listText = (list: Record<string, unknown>[]) => list.map((r) => `- ${rowLine(def.columns, r)}`).join('\n');
    const summarySample = summaryTo.length && fresh.length ? { subject: fill(c.summarySubject, { alert: c.name, count: String(fresh.length), school, name: '…' }), body: fill(c.summaryBody, { alert: c.name, count: String(fresh.length), list: listText(fresh.slice(0, 5)), school, name: '…' }) } : null;
    if (dryRun) {
        const ids = fresh.map((r) => String(r[idKey]));
        const counts: Record<string, number> = {};
        if (perRow.includes('parent')) counts.parents = (await parentsOf(ids)).length;
        if (perRow.includes('student')) counts.students = (await studentsOf(ids)).filter((s) => s.userId || s.email || s.mobile).length;
        if (perRow.includes('staff')) counts.staff = (await staffOf(ids)).length;
        if (summaryTo.includes('class_teacher')) counts['class teachers'] = (await byClassTeacher(fresh)).size;
        for (const s of summaryTo.filter((x) => x.startsWith('role:'))) counts['people with the role'] = (counts['people with the role'] ?? 0) + (await db.user.count({ where: { status: 'active', roles: { some: { roleId: s.slice(5) } } } }));
        return { rows: withId.length, fresh: fresh.length, counts, sample, summarySample };
    }
    let people = 0;
    for (const r of fresh) {
        const id = String(r[idKey]);
        const to: Recipient[] = [];
        if (perRow.includes('parent')) to.push(...(await parentsOf([id])));
        if (perRow.includes('student')) to.push(...(await studentsOf([id])));
        if (perRow.includes('staff')) to.push(...(await staffOf([id])));
        if (!to.length) continue;
        const res = await deliver({ ...base, subject: c.subject, body: c.body, shortText: c.shortText, vars: { ...rowVars(def.columns, r), alert: c.name, school }, dedupe: `custom:${c.id}:${id}:${today}`, sectionIds: idKey === 'studentId' ? await sectionsOfStudents([id]) : [] }, to);
        people += res.people;
    }
    const summary = async (to: Recipient[], list: Record<string, unknown>[], key: string) => {
        if (!to.length || !list.length) return;
        const res = await deliver({ ...base, subject: c.summarySubject, body: c.summaryBody, shortText: c.summarySubject, vars: { alert: c.name, count: String(list.length), list: listText(list), school }, dedupe: `custom:${c.id}:summary-${key}:${today}` }, to);
        people += res.people;
    };
    if (summaryTo.includes('class_teacher')) for (const [staffId, list] of await byClassTeacher(fresh)) await summary(await staffOf([staffId]), list, staffId);
    for (const s of summaryTo.filter((x) => x.startsWith('role:'))) {
        const users = await db.user.findMany({ where: { status: 'active', roles: { some: { roleId: s.slice(5) } } }, select: { id: true } });
        await summary(await usersOf(users.map((u) => u.id)), fresh, s.slice(5));
    }
    return { rows: withId.length, fresh: fresh.length, people };
};

/** What a run would do now (nothing is sent). */
export const previewCustom = async (input: CustomInput, userId: string) => {
    await checkInput(input, userId);
    return runAlert({ ...input, id: 'preview', shortText: input.shortText ?? null, filters: input.filters, createdBy: userId }, true);
};

const record = async (id: string, result: string) => db.customAlert.update({ where: { id }, data: { lastRunAt: new Date(), lastResult: result.slice(0, 300) } });

export const runCustomNow = async (id: string) => {
    const c = await db.customAlert.findFirst({ where: { id } });
    if (!c) throw notFound('Alert not found');
    try {
        const r = await runAlert(c, false);
        const text = `${r.fresh} of ${r.rows} rows · ${r.people} people told`;
        await record(id, text);
        await recordAudit({ action: 'custom_alert_run', entity: 'custom_alert', entityId: id, changes: { name: c.name, result: text } });
        return { result: text };
    } catch (err) {
        await record(id, `failed: ${(err as Error).message}`);
        throw err;
    }
};

/** Whether an alert is due now (school time): its day, after its time, not yet run today. */
const due = (c: { frequency: string; day: number | null; time: string; lastRunAt: Date | null }) => {
    const now = new Date(Date.now() + 5.5 * 3_600_000);
    const today = now.toISOString().slice(0, 10);
    if (c.lastRunAt && new Date(c.lastRunAt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) === today) return false;
    if (minutesIST() < Number(c.time.slice(0, 2)) * 60 + Number(c.time.slice(3, 5))) return false;
    if (c.frequency === 'weekly') return (now.getUTCDay() || 7) === c.day;
    if (c.frequency === 'monthly') return now.getUTCDate() === c.day;
    return true;
};

onQueuePass(async () => {
    const list = await runAsSystem(() => db.customAlert.findMany({ where: { enabled: true }, select: { id: true, tenantId: true, frequency: true, day: true, time: true, lastRunAt: true } }));
    for (const c of list.filter(due))
        await runAsTenant(c.tenantId, async () => {
            // Claim the run (another server may be on it).
            const claimed = await db.customAlert.updateMany({ where: { id: c.id, lastRunAt: c.lastRunAt }, data: { lastRunAt: new Date(), lastResult: 'running…' } });
            if (!claimed.count) return;
            const a = await db.customAlert.findFirst({ where: { id: c.id } });
            if (!a) return;
            try {
                const r = await runAlert(a, false);
                await record(a.id, `${r.fresh} of ${r.rows} rows · ${r.people} people told`);
            } catch (err) {
                await record(a.id, `failed: ${(err as Error).message}`);
                logger.warn('Custom alert failed', { id: a.id, error: (err as Error).message });
            }
        });
});

/** Names of custom alerts, for the log ("custom:<id>" → name). */
export const customNames = async () => new Map((await db.customAlert.findMany({ select: { id: true, name: true } })).map((c) => [`custom:${c.id}`, c.name]));
