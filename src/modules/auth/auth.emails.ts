import { escapeHtml, MailMessage } from '../../core/mail';

/** Emails sent by sign-in flows. Plain, school-branded, readable without HTML. */

const layout = (school: string, body: string) => `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1e293b">
  <h2 style="margin:0 0 24px;color:#0f172a">${escapeHtml(school)}</h2>
  ${body}
  <p style="margin-top:32px;font-size:12px;color:#94a3b8">This is an automatic message from ${escapeHtml(school)}'s school management system.</p>
</div>`;

export const passwordResetEmail = (to: string, school: string, name: string, code: string, minutes: number): MailMessage => ({
    to,
    fromName: school,
    subject: `${school}: your password reset code`,
    text: `Hello ${name},\n\nYour password reset code is ${code}. It is valid for ${minutes} minutes.\n\nIf you didn't ask for this, ignore this email; your password stays the same.\n`,
    html: layout(
        school,
        `<p>Hello ${escapeHtml(name)},</p>
         <p>Your password reset code is:</p>
         <p style="font-size:32px;font-weight:bold;letter-spacing:6px;font-family:monospace">${escapeHtml(code)}</p>
         <p>It is valid for ${minutes} minutes. If you didn't ask for this, ignore this email; your password stays the same.</p>`
    ),
});

export const welcomeEmail = (to: string, school: string, name: string, username: string, password: string): MailMessage => ({
    to,
    fromName: school,
    subject: `${school}: your sign-in details`,
    text: `Hello ${name},\n\nAn account has been created for you.\nUsername: ${username}\nFirst password: ${password}\n\nYou will be asked to choose your own password when you first sign in.\n`,
    html: layout(
        school,
        `<p>Hello ${escapeHtml(name)},</p>
         <p>An account has been created for you.</p>
         <p>Username: <b>${escapeHtml(username)}</b><br/>First password: <b style="font-family:monospace">${escapeHtml(password)}</b></p>
         <p>You will be asked to choose your own password when you first sign in.</p>`
    ),
});
