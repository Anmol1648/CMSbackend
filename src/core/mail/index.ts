import fs from 'fs';
import path from 'path';
import tls from 'tls';
import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../logger';

/**
 * Sends email over SMTP. In tests nothing leaves the process (messages go to `testOutbox`);
 * without SMTP settings the message is logged (subject + recipient only) instead of sent.
 */

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
    /** Display name for the From header, e.g. the school's name. */
    fromName?: string;
    /** Inline images referenced as <img src="cid:…"> (the school logo). */
    attachments?: { filename: string; content: Buffer; contentType: string; cid: string }[];
}

export const testOutbox: MailMessage[] = [];

let transporter: Transporter | null | undefined;

/**
 * SMTP_CA_FILE: an extra root certificate to trust for mail, e.g. when antivirus software (AVG / Avast
 * "Mail Shield") re-signs mail traffic. It is added to the normal public roots; verification stays on.
 * Create it with `node scripts/save-smtp-root-ca.js`.
 */
const extraTrust = () => {
    const file = process.env.SMTP_CA_FILE?.trim();
    if (!file) return undefined;
    try {
        const pem = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
        return { ca: [...tls.rootCertificates, pem] };
    } catch (err) {
        logger.error(`SMTP_CA_FILE could not be read (${file}); using the normal certificates only`, { error: (err as Error).message });
        return undefined;
    }
};

const getTransporter = (): Transporter | null => {
    if (transporter !== undefined) return transporter;
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST) {
        transporter = null;
        return null;
    }
    const port = Number(SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
        tls: extraTrust(),
        // Keep the connection open between messages (an import sends many in a row).
        pool: true,
        maxConnections: 2,
    });
    return transporter;
};

export const sendMail = async (message: MailMessage): Promise<void> => {
    if (process.env.NODE_ENV === 'test') {
        testOutbox.push(message);
        return;
    }
    const t = getTransporter();
    if (!t) {
        logger.warn('SMTP is not configured; email not sent', { to: message.to, subject: message.subject });
        return;
    }
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    await t.sendMail({
        from: message.fromName ? `"${message.fromName.replace(/"/g, '')}" <${from}>` : from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
    });
    logger.info('Email sent', { to: message.to, subject: message.subject });
};

/**
 * Sends email without making the request wait: SMTP can take many seconds per message (and much
 * longer through a mail scanner), and an import may send hundreds. Messages go out one after
 * another in the background; a failure is logged and passed to onError (e.g. an audit entry).
 * Under test it finishes before returning, so tests can read testOutbox.
 */
let queue: Promise<void> = Promise.resolve();
export const sendInBackground = (task: () => Promise<void>, onError?: (err: Error) => unknown): Promise<void> => {
    const done = queue.then(() =>
        task().catch(async (err: Error) => {
            logger.error('Email could not be sent', { error: err.message });
            try {
                await onError?.(err);
            } catch (inner) {
                logger.error('Email failure could not be recorded', { error: (inner as Error).message });
            }
        })
    );
    queue = done;
    return process.env.NODE_ENV === 'test' ? done : Promise.resolve();
};

/** Connects and logs in to the SMTP server without sending anything (for setup checks). */
export const verifyMailConnection = async (): Promise<string> => {
    const t = getTransporter();
    if (!t) return 'SMTP is not configured (SMTP_HOST is empty)';
    await t.verify();
    return `Connected and signed in to ${process.env.SMTP_HOST}`;
};

/** Escapes text for use inside HTML email templates. */
export const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
