import type { User, UserKind } from '@prisma/client';
import { db, Db, Tx } from '../../core/db';
import { getTenantId } from '../../core/context';
import { conflict } from '../../core/errors';
import { generateTemporaryPassword, hashPassword } from '../../core/password';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { MailMessage, sendMail } from '../../core/mail';
import { ACCOUNTS } from './auth.settings';
import { normalizeEmail, normalizeMobile } from './identity';
import { WELCOME_EMAIL } from './auth.emails';
import { prepareTemplatedEmail } from '../email-templates/email-templates.service';

/**
 * Creates sign-in accounts for people (staff, students, guardians, admins). Person modules call this
 * inside their own transaction and send the welcome email after it commits.
 */

export interface CreateLoginInput {
    kind: UserKind;
    displayName: string;
    email?: string | null;
    mobile?: string | null;
    /** Preferred usernames in order (e.g. admission number, then name); the first free one is used. */
    usernameCandidates?: string[];
    /** Used when System Settings → Accounts → first password = date of birth. */
    dateOfBirth?: Date | null;
    /** Defaults to the roles marked "default for" this kind. */
    roleSlugs?: string[];
}

export interface CreatedLogin {
    user: User;
    /** Shown once to whoever created the account. */
    temporaryPassword: string;
    /** Send with sendWelcomeEmail() after the surrounding transaction commits. */
    welcome: MailMessage | null;
}

/** Turns free text into a username base: "Riya Sharma" → "riya.sharma". */
export const toUsernameBase = (raw: string) =>
    raw
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '.')
        .replace(/[^a-z0-9._-]/g, '')
        .replace(/\.{2,}/g, '.')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 56);

const ddmmyyyy = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`;

/** First free username among the candidates; adds 2, 3, … to the first usable base if all are taken. */
const pickUsername = async (client: Db | Tx, candidates: string[]) => {
    const bases = [...new Set(candidates.map(toUsernameBase).filter((b) => b.length >= 3))];
    if (!bases.length) bases.push('user');
    const taken = new Set(
        (await client.user.findMany({ where: { OR: bases.map((b) => ({ username: { startsWith: b } })) }, select: { username: true } })).map((u) => u.username)
    );
    for (const b of bases) if (!taken.has(b)) return b;
    for (let n = 2; n < 10_000; n++) if (!taken.has(`${bases[0]}${n}`)) return `${bases[0]}${n}`;
    throw conflict('Could not find a free username');
};

export const createLogin = async (input: CreateLoginInput, client: Db | Tx = db): Promise<CreatedLogin> => {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('createLogin needs a school in context');
    const email = input.email ? normalizeEmail(input.email) : null;
    const mobile = input.mobile ? normalizeMobile(input.mobile) : null;

    if (email && (await client.user.findFirst({ where: { email }, select: { id: true } }))) {
        throw conflict(`Another account already uses ${email}`);
    }
    if (mobile && (await client.user.findFirst({ where: { mobile }, select: { id: true } }))) {
        throw conflict(`Another account already uses the mobile number ${mobile}`);
    }

    const s = await getSettings({ firstPassword: ACCOUNTS.firstPassword, welcomeEmail: ACCOUNTS.welcomeEmail });
    const username = await pickUsername(client, [...(input.usernameCandidates ?? []), input.displayName, email?.split('@')[0] ?? '']);
    const temporaryPassword = s.firstPassword === 'date_of_birth' && input.dateOfBirth ? ddmmyyyy(input.dateOfBirth) : generateTemporaryPassword();

    const user = await client.user.create({
        data: {
            tenantId,
            kind: input.kind,
            username,
            email,
            mobile,
            displayName: input.displayName.trim(),
            passwordHash: await hashPassword(temporaryPassword),
            mustChangePassword: true,
        },
    });

    const roles = await client.role.findMany({
        where: input.roleSlugs?.length ? { slug: { in: input.roleSlugs } } : { defaultFor: input.kind },
        select: { id: true },
    });
    if (roles.length) {
        await client.userRole.createMany({ data: roles.map((r) => ({ tenantId, userId: user.id, roleId: r.id })) });
    }

    let welcome: MailMessage | null = null;
    if (email && s.welcomeEmail) {
        welcome = await prepareTemplatedEmail(WELCOME_EMAIL.key, email, { name: user.displayName, username, password: temporaryPassword });
    }
    await recordAudit({ action: 'create', entity: 'user', entityId: user.id, changes: { username, kind: input.kind } });
    return { user, temporaryPassword, welcome };
};

/** Sends the welcome email of a created login (call after the transaction commits). */
export const sendWelcomeEmail = async (login: Pick<CreatedLogin, 'welcome'>) => {
    if (login.welcome) await sendMail(login.welcome);
};
