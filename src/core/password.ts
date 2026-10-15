import bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '10', 10);

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, SALT_ROUNDS);

export const comparePassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

// No look-alike characters (0/o, 1/l/i) so a password read off a screen or slip is typed correctly.
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';

/** A one-time password like `kmrt-4827-xbqe`: 12 characters plus dashes, always has letters and digits. */
export const generateTemporaryPassword = (): string => {
    const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[randomInt(chars.length)]).join('');
    return `${pick(LETTERS, 4)}-${pick(DIGITS, 4)}-${pick(LETTERS, 4)}`;
};
