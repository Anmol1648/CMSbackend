import { AppError } from '../../core/errors';
import { ErrorCode } from '../../core/auth.types';
import { comparePassword } from '../../core/password';
import { getSettings } from '../../core/settings';
import { db } from '../../core/db';
import { PASSWORDS } from './auth.settings';

/** Password rules come from System Settings → Passwords. */

export const passwordRuleMessages = async (password: string, person?: { username?: string; displayName?: string }) => {
    const s = await getSettings(PASSWORDS);
    const problems: string[] = [];
    if (password.length < s.minLength) problems.push(`must be at least ${s.minLength} characters`);
    if (password.length > 128) problems.push('must be at most 128 characters');
    if (s.requireLetter && !/[A-Za-z]/.test(password)) problems.push('must contain a letter');
    if (s.requireNumber && !/[0-9]/.test(password)) problems.push('must contain a number');
    if (s.requireMixedCase && !(/[a-z]/.test(password) && /[A-Z]/.test(password))) problems.push('must mix upper and lower case letters');
    if (s.requireSymbol && !/[^A-Za-z0-9]/.test(password)) problems.push('must contain a symbol');
    const lower = password.toLowerCase();
    if (person?.username && lower.includes(person.username.toLowerCase())) problems.push("can't contain your username");
    return problems;
};

/** Throws a 400 listing every broken rule, or if the password was used recently. */
export const assertPasswordAllowed = async (
    password: string,
    user: { id: string; username: string; displayName: string; passwordHash: string } | null,
    field = 'newPassword'
) => {
    const problems = await passwordRuleMessages(password, user ?? undefined);
    if (!problems.length && user) {
        const { rememberLast } = await getSettings({ rememberLast: PASSWORDS.rememberLast });
        if (rememberLast > 0) {
            const history = await db.passwordHistory.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: 'desc' },
                take: rememberLast,
                select: { passwordHash: true },
            });
            const hashes = [user.passwordHash, ...history.map((h) => h.passwordHash)];
            for (const hash of hashes) {
                if (await comparePassword(password, hash)) {
                    problems.push(rememberLast === 1 ? "can't be your current password" : `can't be one of your last ${rememberLast} passwords`);
                    break;
                }
            }
        }
    }
    if (problems.length) {
        throw new AppError(
            `Password ${problems[0]}`,
            400,
            ErrorCode.PASSWORD_POLICY,
            true,
            problems.map((message) => ({ field, message }))
        );
    }
};
