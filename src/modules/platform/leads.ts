import { z } from 'zod';
import { db } from '../../core/db';
import { runAsSystem } from '../../core/context';
import { notFound } from '../../core/errors';
import { logger } from '../../core/logger';
import { escapeHtml, sendInBackground, sendMail } from '../../core/mail';
import { platformLog } from './platform-log';

/**
 * Demo requests from the website: saved for the console (Leads) and emailed to Klytos
 * (PLATFORM_LEADS_EMAIL, else every active owner).
 */

const sys = <T>(fn: () => Promise<T>) => runAsSystem(fn);

export const leadSchema = z.strictObject({
    name: z.string().trim().min(2, 'is too short').max(120),
    school: z.string().trim().min(2, 'is too short').max(200),
    city: z.string().trim().max(80).nullable().optional(),
    phone: z.string().trim().regex(/^[+0-9 ()-]{10,20}$/, 'must be a phone number'),
    email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('').transform(() => null)),
    students: z.number().int().min(0).max(100_000).nullable().optional(),
    board: z.string().trim().max(40).nullable().optional(),
    preferredTime: z.string().trim().max(80).nullable().optional(),
    message: z.string().trim().max(2000).nullable().optional(),
    language: z.enum(['en', 'hi']).default('en'),
    /** Left empty by people; bots fill it in. */
    website: z.string().max(200).optional(),
});

/** A demo request from the website. */
export const addLead = async (input: z.infer<typeof leadSchema>, ip?: string) => {
    if (input.website) return { ok: true }; // a bot: say thanks, keep nothing
    const { website: _w, ...data } = input;
    const lead = await sys(() => db.platformLead.create({ data: { ...data, city: data.city || null, email: data.email || null, board: data.board || null, preferredTime: data.preferredTime || null, message: data.message || null, ip: ip ?? null } }));
    sendInBackground(async () => {
        const to = process.env.PLATFORM_LEADS_EMAIL?.trim() || (await sys(() => db.platformUser.findMany({ where: { role: 'owner', status: 'active' }, select: { email: true } }))).map((u) => u.email).join(', ');
        if (!to) return;
        const rows: [string, string | number | null | undefined][] = [['Name', lead.name], ['School', lead.school], ['City', lead.city], ['Phone', lead.phone], ['Email', lead.email], ['Students', lead.students], ['Board', lead.board], ['Best time', lead.preferredTime], ['Message', lead.message], ['Language', lead.language === 'hi' ? 'Hindi' : 'English']];
        const filled = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
        await sendMail({
            to,
            subject: `New demo request: ${lead.school}${lead.city ? `, ${lead.city}` : ''}`,
            text: `${filled.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nSee it in the console: Leads.`,
            html: `<p><b>New demo request from the website</b></p><table>${filled.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${k}</td><td><b>${escapeHtml(String(v))}</b></td></tr>`).join('')}</table><p>See it in the console: Leads.</p>`,
        });
    }, (err) => logger.warn('Lead email failed', { error: err.message }));
    return { ok: true };
};

export const leadsQuery = z.object({ status: z.enum(['new', 'contacted', 'demo', 'won', 'lost', '']).default('') });
export const listLeads = async (q: z.infer<typeof leadsQuery>) => {
    const [rows, counts] = await Promise.all([sys(() => db.platformLead.findMany({ where: q.status ? { status: q.status } : {}, orderBy: { createdAt: 'desc' }, take: 300 })), sys(() => db.platformLead.groupBy({ by: ['status'], _count: { _all: true } }))]);
    return { rows: rows.map(({ ip: _ip, ...r }) => r), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
};

export const leadUpdateSchema = z.strictObject({ status: z.enum(['new', 'contacted', 'demo', 'won', 'lost']), notes: z.string().trim().max(4000).nullable().optional() });
export const updateLead = async (id: string, input: z.infer<typeof leadUpdateSchema>, by: string, ip?: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Not found');
    const lead = await sys(() => db.platformLead.findUnique({ where: { id } }));
    if (!lead) throw notFound('Not found');
    await sys(() => db.platformLead.update({ where: { id }, data: { status: input.status, notes: input.notes ?? null } }));
    if (lead.status !== input.status) await platformLog(by, 'lead_status', { details: { school: lead.school, from: lead.status, to: input.status }, ip });
    return { ok: true };
};
