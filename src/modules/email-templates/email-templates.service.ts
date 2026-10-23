import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { readFile } from '../../core/files';
import { MailMessage, sendMail } from '../../core/mail';
import { EmailSchool, renderEmailHtml, renderEmailText, renderSubject } from '../../core/mail/layout';
import { checkTemplateText, EmailTemplateDef, findEmailTemplateDef, listEmailTemplateDefs, placeholdersOf } from '../../core/mail/templates';

/**
 * Rendering and sending the school's emails, and the Email Templates screen's data.
 * Every email = the school's wording (or the default) inside the one branded layout.
 */

const definition = (key: string): EmailTemplateDef => {
    const def = findEmailTemplateDef(key);
    if (!def) throw notFound('Unknown email');
    return def;
};

/** The school's details for the email frame; the logo as an inline attachment (send) or data URI (preview). */
export const schoolFrame = async (mode: 'send' | 'preview') => {
    const p = await db.schoolProfile.findFirst();
    if (!p) throw notFound('School profile not found');
    let logo: { data: Buffer; mime: string; name: string } | null = null;
    if (p.logoFileId) {
        try {
            const { file, data } = await readFile(p.logoFileId);
            logo = { data, mime: file.mimeType, name: file.originalName };
        } catch {
            logo = null; // a missing logo must never stop an email
        }
    }
    const school: EmailSchool = {
        name: p.shortName ?? p.legalName,
        fullName: p.legalName,
        addressLine: [p.addressLine1, p.city, p.state, p.pincode].filter(Boolean).join(', ') || null,
        phone: p.phone,
        email: p.email,
        website: p.website,
        logoSrc: logo ? (mode === 'send' ? 'cid:school-logo' : `data:${logo.mime};base64,${logo.data.toString('base64')}`) : null,
    };
    return { school, logo };
};

const wordingOf = async (def: EmailTemplateDef) => {
    const custom = await db.emailTemplate.findFirst({ where: { key: def.key } });
    return { subject: custom?.subject ?? def.subject, body: custom?.body ?? def.body, custom };
};

/** Builds a finished email (subject, HTML, text, logo attachment). `override` = unsaved wording (preview / test). */
export const renderEmail = async (
    key: string,
    vars: Record<string, string>,
    opts: { mode: 'send' | 'preview'; override?: { subject: string; body: string } } = { mode: 'send' }
) => {
    const def = definition(key);
    const wording = opts.override ?? (await wordingOf(def));
    const { school, logo } = await schoolFrame(opts.mode);
    const all = { school: school.name, schoolFullName: school.fullName, ...vars };
    const placeholders = placeholdersOf(def);
    return {
        subject: renderSubject(wording.subject, all, placeholders),
        html: renderEmailHtml(school, wording.subject, wording.body, all, placeholders),
        text: renderEmailText(school, wording.body, all, placeholders),
        fromName: school.name,
        attachments: logo && opts.mode === 'send' ? [{ filename: logo.name, content: logo.data, contentType: logo.mime, cid: 'school-logo' }] : undefined,
    };
};

/** Renders the school's email for `key` and sends it to `to`. */
export const sendTemplatedEmail = async (key: string, to: string, vars: Record<string, string>) => {
    const e = await renderEmail(key, vars, { mode: 'send' });
    const message: MailMessage = { to, subject: e.subject, html: e.html, text: e.text, fromName: e.fromName, attachments: e.attachments };
    await sendMail(message);
};

/** Builds (without sending) a templated email, e.g. to send after a transaction commits. */
export const prepareTemplatedEmail = async (key: string, to: string, vars: Record<string, string>): Promise<MailMessage> => {
    const e = await renderEmail(key, vars, { mode: 'send' });
    return { to, subject: e.subject, html: e.html, text: e.text, fromName: e.fromName, attachments: e.attachments };
};

// ─── Email Templates screen ──────────────────────────────────────────────────

const exampleValues = (def: EmailTemplateDef) => Object.fromEntries(def.placeholders.map((p) => [p.key, p.example]));

export const listTemplates = async () => {
    const custom = new Map((await db.emailTemplate.findMany()).map((t) => [t.key, t]));
    return listEmailTemplateDefs().map((d) => ({ key: d.key, label: d.label, description: d.description, isCustom: custom.has(d.key), updatedAt: custom.get(d.key)?.updatedAt ?? null }));
};

export const getTemplate = async (key: string) => {
    const def = definition(key);
    const w = await wordingOf(def);
    return {
        key: def.key,
        label: def.label,
        description: def.description,
        subject: w.subject,
        body: w.body,
        isCustom: !!w.custom,
        updatedAt: w.custom?.updatedAt ?? null,
        defaults: { subject: def.subject, body: def.body },
        placeholders: placeholdersOf(def).map((p) => ({ key: p.key, label: p.label, example: p.example, required: def.required.includes(p.key) })),
    };
};

const checkWording = (def: EmailTemplateDef, subject: string, body: string) => {
    const issues = checkTemplateText(def, subject, body);
    if (issues.length) throw badRequest(issues[0].message.startsWith('must') ? `The text ${issues[0].message}` : issues[0].message, issues);
};

export const saveTemplate = async (key: string, input: { subject: string; body: string }, userId: string) => {
    const def = definition(key);
    checkWording(def, input.subject, input.body);
    const before = await wordingOf(def);
    const tenantId = getTenantId()!;
    // Saving the default wording again is the same as resetting.
    if (input.subject === def.subject && input.body === def.body) {
        await db.emailTemplate.deleteMany({ where: { key } });
    } else {
        await db.emailTemplate.upsert({
            where: { tenantId_key: { tenantId, key } },
            create: { tenantId, key, subject: input.subject, body: input.body, updatedBy: userId },
            update: { subject: input.subject, body: input.body, updatedBy: userId },
        });
    }
    const changes: Record<string, [string, string]> = {};
    if (before.subject !== input.subject) changes.subject = [before.subject, input.subject];
    if (before.body !== input.body) changes.body = [before.body, input.body];
    if (Object.keys(changes).length) await recordAudit({ action: 'update', entity: 'email_template', entityId: key, changes });
    return getTemplate(key);
};

export const resetTemplate = async (key: string) => {
    const def = definition(key);
    const before = await wordingOf(def);
    if (before.custom) {
        await db.emailTemplate.deleteMany({ where: { key } });
        await recordAudit({ action: 'update', entity: 'email_template', entityId: key, changes: { reset: [true, true], subject: [before.subject, def.subject], body: [before.body, def.body] } });
    }
    return getTemplate(key);
};

/** The email with example values, for the live preview (unsaved wording allowed). */
export const previewTemplate = async (key: string, override?: { subject: string; body: string }) => {
    const def = definition(key);
    const e = await renderEmail(key, exampleValues(def), { mode: 'preview', override });
    return { subject: e.subject, html: e.html, problems: override ? checkTemplateText(def, override.subject, override.body) : [] };
};

/** Sends the email with example values to the signed-in person's own address. */
export const sendTestEmail = async (key: string, userId: string, override?: { subject: string; body: string }) => {
    const def = definition(key);
    if (override) checkWording(def, override.subject, override.body);
    const me = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!me?.email) throw badRequest('Your account has no email address. Add one to receive a test email.');
    const e = await renderEmail(key, exampleValues(def), { mode: 'send', override });
    await sendMail({ to: me.email, subject: `[Test] ${e.subject}`, html: e.html, text: e.text, fromName: e.fromName, attachments: e.attachments });
    await recordAudit({ action: 'email_test', entity: 'email_template', entityId: key, changes: { to: me.email } });
    return { to: me.email };
};
