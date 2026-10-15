import type { User } from '@prisma/client';
import { db } from '../../core/db';

/** How sign-in identifiers are normalised and matched (email / username / mobile). */

export type IdentifierKind = 'email' | 'username' | 'mobile';

export const normalizeEmail = (raw: string) => raw.trim().toLowerCase();
export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();
/** Keeps a leading + and the digits: "+91 98765-43210" → "+919876543210". */
export const normalizeMobile = (raw: string) => {
    const t = raw.trim();
    return (t.startsWith('+') ? '+' : '') + t.replace(/\D/g, '');
};

const looksLikeMobile = (raw: string) => /^\+?[0-9][0-9 ()-]{5,19}$/.test(raw.trim());

/**
 * Finds the active-or-not user (current school) that an identifier refers to, trying only the
 * allowed kinds. Digits-only input can be a username (e.g. an admission number) or a mobile:
 * username wins if both exist.
 */
export const findUserByIdentifier = async (raw: string, allowed: IdentifierKind[]): Promise<User | null> => {
    const value = raw.trim();
    if (!value) return null;
    const ors: { email?: string; username?: string; mobile?: string }[] = [];
    if (value.includes('@')) {
        if (allowed.includes('email')) ors.push({ email: normalizeEmail(value) });
    } else {
        if (allowed.includes('username')) ors.push({ username: normalizeUsername(value) });
        if (allowed.includes('mobile') && looksLikeMobile(value)) ors.push({ mobile: normalizeMobile(value) });
    }
    if (!ors.length) return null;
    const users = await db.user.findMany({ where: { OR: ors }, take: 2 });
    const username = normalizeUsername(value);
    return users.find((u) => u.username === username) ?? users[0] ?? null;
};
