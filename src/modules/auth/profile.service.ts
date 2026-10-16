import { db } from '../../core/db';
import { badRequest, conflict, forbidden } from '../../core/errors';
import { comparePassword } from '../../core/password';
import { getSetting } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { ACCOUNTS, SelfEditField } from './auth.settings';
import { normalizeEmail, normalizeMobile } from './identity';
import { sessionEnded, userSummary } from './auth.service';

/** My account → Details: what people may change on their own account (System Settings → Accounts). */

export const selfEditable = () => getSetting(ACCOUNTS.selfEdit);

export const assertSelfEditable = async (field: SelfEditField) => {
    if (!(await selfEditable()).includes(field)) throw forbidden('The school office manages this. Ask them to change it.');
};

const LABEL: Record<SelfEditField, string> = { photo: 'photo', name: 'name', email: 'email', mobile: 'mobile number' };

export interface MyDetailsInput {
    displayName?: string;
    email?: string | null;
    mobile?: string | null;
    currentPassword?: string;
}

export const updateMyDetails = async (userId: string, input: MyDetailsInput) => {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw sessionEnded();
    const allowed = await selfEditable();

    const next = {
        displayName: input.displayName === undefined ? user.displayName : input.displayName.trim(),
        email: input.email === undefined ? user.email : input.email ? normalizeEmail(input.email) : null,
        mobile: input.mobile === undefined ? user.mobile : input.mobile ? normalizeMobile(input.mobile) : null,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== user[k]);
    if (!changed.length) return userSummary(user);

    const field = (k: keyof typeof next): SelfEditField => (k === 'displayName' ? 'name' : k);
    const locked = changed.filter((k) => !allowed.includes(field(k)));
    if (locked.length) throw forbidden(`The school office manages your ${locked.map((k) => LABEL[field(k)]).join(' and ')}. Ask them to change it.`);

    // Email and mobile are used to sign in and to reset the password: confirm it's really the owner.
    if (changed.includes('email') || changed.includes('mobile')) {
        if (!input.currentPassword) throw badRequest('Enter your current password to change your email or mobile', [{ field: 'currentPassword', message: 'is required' }]);
        if (!(await comparePassword(input.currentPassword, user.passwordHash))) {
            throw badRequest('Current password is not right', [{ field: 'currentPassword', message: 'is not right' }]);
        }
    }
    for (const k of ['email', 'mobile'] as const) {
        if (!changed.includes(k) || !next[k]) continue;
        const other = await db.user.findFirst({ where: { [k]: next[k], id: { not: userId } }, select: { id: true } });
        if (other) throw conflict(`Another account already uses this ${k === 'email' ? 'email address' : 'mobile number'}`);
    }

    const updated = await db.user.update({ where: { id: userId }, data: Object.fromEntries(changed.map((k) => [k, next[k]])) });
    await recordAudit({ action: 'update', entity: 'user', entityId: userId, changes: Object.fromEntries(changed.map((k) => [k, [user[k], next[k]]])) });
    return userSummary(updated);
};
