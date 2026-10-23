import { decryptSecret } from '../../core/encryption';
import { getSettings } from '../../core/settings';
import { readFile } from '../../core/files';
import { sendMail } from '../../core/mail';
import { renderEmailHtml, renderEmailText } from '../../core/mail/layout';
import { schoolFrame } from '../email-templates/email-templates.service';
import { renderDocument } from '../documents/documents.service';
import { ALERTS } from './alerts.settings';

/**
 * Sending one message on email, SMS or WhatsApp. SMS and WhatsApp providers are behind one shape:
 * a school picks its provider and enters the keys; nothing else changes. (They are only switched on
 * once a school has an account.)
 */

export interface Outbound {
    to: string;
    subject: string;
    body: string;
    attachmentIds: string[];
    /** ERP documents to render as PDFs for this person (e.g. each child's report card). */
    documents: { key: string; params: Record<string, string>; asUserId: string }[];
}

/** Thrown for problems that will not go away by trying again (bad number, missing keys). */
export class PermanentError extends Error {}

const keyOf = (enc: string) => {
    if (!enc) return '';
    try {
        return decryptSecret(enc);
    } catch {
        return '';
    }
};

/** 10-digit Indian numbers get +91; others are used as given (digits only). */
export const phoneE164 = (mobile: string) => {
    const d = mobile.replace(/\D/g, '');
    if (d.length === 10) return `91${d}`;
    if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
    if (d.length < 10 || d.length > 15) throw new PermanentError('is not a valid mobile number');
    return d;
};

const post = async (url: string, init: RequestInit) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) {
        const err = `${res.status} ${text.slice(0, 200)}`;
        throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentError(err) : new Error(err);
    }
    return text;
};

export const sendEmail = async (m: Outbound) => {
    const { school, logo } = await schoolFrame('send');
    const attachments: { filename: string; content: Buffer; contentType: string; cid?: string }[] = [];
    if (logo) attachments.push({ filename: logo.name, content: logo.data, contentType: logo.mime, cid: 'school-logo' });
    for (const id of m.attachmentIds) {
        const { file, data } = await readFile(id);
        attachments.push({ filename: file.originalName, content: data, contentType: file.mimeType });
    }
    for (const doc of m.documents) {
        const d = await renderDocument(doc.key, doc.params, doc.asUserId);
        attachments.push({ filename: d.filename, content: d.pdf, contentType: 'application/pdf' });
    }
    await sendMail({
        to: m.to,
        subject: m.subject,
        html: renderEmailHtml(school, m.subject, m.body, {}, []),
        text: renderEmailText(school, m.body, {}, []),
        fromName: school.name,
        attachments: attachments as never,
    });
};

export const sendSms = async (m: Outbound) => {
    const s = await getSettings({ provider: ALERTS.smsProvider, sender: ALERTS.smsSender, key: ALERTS.smsKey, account: ALERTS.smsAccount, template: ALERTS.smsTemplate });
    const key = keyOf(s.key);
    if (!key) throw new PermanentError('SMS keys are not entered (Alerts → Channels)');
    const to = phoneE164(m.to);
    const text = m.body.slice(0, 480);
    if (s.provider === 'twilio') {
        const sid = keyOf(s.account);
        if (!sid || !s.sender) throw new PermanentError('Twilio needs the account SID and the sender number');
        await post(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
            method: 'POST',
            headers: { Authorization: `Basic ${Buffer.from(`${sid}:${key}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: s.sender, To: `+${to}`, Body: text }).toString(),
        });
    } else if (s.provider === 'fast2sms') {
        await post('https://www.fast2sms.com/dev/bulkV2', {
            method: 'POST',
            headers: { authorization: key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ route: 'q', message: text, numbers: to.slice(-10), ...(s.sender ? { sender_id: s.sender } : {}) }),
        });
    } else {
        const template = keyOf(s.template);
        if (!template) throw new PermanentError('MSG91 needs the DLT template (flow) id');
        await post('https://control.msg91.com/api/v5/flow/', {
            method: 'POST',
            headers: { authkey: key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ template_id: template, short_url: '0', recipients: [{ mobiles: to, message: text }] }),
        });
    }
};

export const sendWhatsapp = async (m: Outbound) => {
    const s = await getSettings({ provider: ALERTS.whatsappProvider, number: ALERTS.whatsappNumber, key: ALERTS.whatsappKey, account: ALERTS.whatsappAccount, template: ALERTS.whatsappTemplate });
    const key = keyOf(s.key);
    if (!key) throw new PermanentError('WhatsApp keys are not entered (Alerts → Channels)');
    const to = phoneE164(m.to);
    const text = m.body.slice(0, 1000);
    if (s.provider === 'gupshup') {
        const app = keyOf(s.account);
        if (!app || !s.number) throw new PermanentError('Gupshup needs the app name and the business number');
        await post('https://api.gupshup.io/wa/api/v1/msg', {
            method: 'POST',
            headers: { apikey: key, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ channel: 'whatsapp', source: s.number.replace(/\D/g, ''), destination: to, 'src.name': app, message: JSON.stringify({ type: 'text', text }) }).toString(),
        });
    } else {
        const phoneId = keyOf(s.account);
        if (!phoneId) throw new PermanentError('Meta needs the phone number id');
        const template = keyOf(s.template);
        // Outside a 24-hour chat window WhatsApp only delivers approved templates: the message goes as the template's one variable.
        const payload = template
            ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
            : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
        await post(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    }
};
