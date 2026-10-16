import { escapeHtml } from './index';
import type { TemplatePlaceholder } from './templates';

/**
 * The one email layout: school logo + name, the message, school contact details. Table-based with
 * inline styles so it looks the same in Gmail, Outlook and phone mail apps.
 */

export interface EmailSchool {
    name: string;
    fullName: string;
    addressLine?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    /** <img src> for the logo: a cid: reference when sending, a data: URI in previews. */
    logoSrc?: string | null;
}

const PRIMARY = '#1A365D';

const fill = (text: string, vars: Record<string, string>, html: boolean, placeholders: TemplatePlaceholder[]) =>
    text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, key: string) => {
        if (!(key in vars)) return html ? escapeHtml(whole) : whole;
        const value = vars[key];
        if (!html) return value;
        const style = placeholders.find((p) => p.key === key)?.style;
        return style === 'code'
            ? `<span style="display:inline-block;font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:700;letter-spacing:4px;color:${PRIMARY};background:#eef3fb;border-radius:10px;padding:10px 18px">${escapeHtml(value)}</span>`
            : `<b>${escapeHtml(value)}</b>`;
    });

/** Turns the plain wording (blank line = new paragraph) into email HTML with the school's frame. */
export const renderEmailHtml = (school: EmailSchool, subject: string, body: string, vars: Record<string, string>, placeholders: TemplatePlaceholder[]) => {
    const paragraphs = body
        .replace(/\r\n/g, '\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
            // Escape the wording, then put the values in (values are escaped inside fill). A private-use character (U+E000) marks where.
            const tokens: string[] = [];
            const safe = escapeHtml(p.replace(/\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/g, (m) => `\uE000${tokens.push(m) - 1}\uE000`));
            const withValues = safe.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => fill(tokens[Number(i)], vars, true, placeholders));
            return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#334155">${withValues.replace(/\n/g, '<br/>')}</p>`;
        })
        .join('');

    const contact = [school.addressLine, school.phone, school.email, school.website].filter(Boolean).map((c) => escapeHtml(String(c))).join(' · ');
    const logo = school.logoSrc
        ? `<img src="${school.logoSrc}" alt="" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:10px;object-fit:contain;background:#ffffff"/>`
        : '';

    return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(fill(subject, vars, false, placeholders))}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
    <tr><td style="background:${PRIMARY};padding:20px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        ${logo ? `<td style="padding-right:14px">${logo}</td>` : ''}
        <td style="color:#ffffff;font-size:18px;font-weight:700">${escapeHtml(school.name)}${school.fullName && school.fullName !== school.name ? `<div style="font-size:12px;font-weight:400;opacity:.75;margin-top:2px">${escapeHtml(school.fullName)}</div>` : ''}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px 28px 12px">${paragraphs}</td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:18px;color:#94a3b8">
      ${contact ? `${contact}<br/>` : ''}This is an automatic message from ${escapeHtml(school.name)}'s school management system.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
};

/** The same message as plain text (for mail apps that don't show HTML). */
export const renderEmailText = (school: EmailSchool, body: string, vars: Record<string, string>, placeholders: TemplatePlaceholder[]) => {
    const text = fill(body.replace(/\r\n/g, '\n'), vars, false, placeholders).trim();
    const contact = [school.addressLine, school.phone, school.email, school.website].filter(Boolean).join(' · ');
    return `${text}\n\n--\n${school.fullName || school.name}${contact ? `\n${contact}` : ''}\n`;
};

export const renderSubject = (subject: string, vars: Record<string, string>, placeholders: TemplatePlaceholder[]) => fill(subject, vars, false, placeholders).replace(/\s+/g, ' ').trim();
