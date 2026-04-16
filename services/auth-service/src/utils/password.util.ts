import bcrypt from 'bcrypt';
import { serviceHandler } from '@shared/core';

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '10');

export const hashPassword = serviceHandler(async (password: string): Promise<string> => {
    return await bcrypt.hash(password, SALT_ROUNDS);
});

export const comparePassword = serviceHandler(async (password: string, hash: string): Promise<boolean> => {
    return await bcrypt.compare(password, hash);
});
