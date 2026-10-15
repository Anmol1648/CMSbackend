import { z } from 'zod';

const required = (label: string, max = 200) => z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);
const password = z.string({ error: 'Password is required' }).min(1, 'Password is required').max(128);

export const loginSchema = z.strictObject({
    identifier: required('Email, username or mobile'),
    password,
    rememberMe: z.boolean().optional(),
});

export const mfaVerifySchema = z.strictObject({
    mfaToken: required('Sign-in step', 2000),
    code: z.string().trim().regex(/^[0-9]{6}$/, 'must be the 6-digit code from your app'),
});

export const changePasswordSchema = z.strictObject({
    currentPassword: password,
    newPassword: password,
});

export const forgotPasswordSchema = z.strictObject({
    identifier: required('Email, username or mobile'),
});

export const resetPasswordSchema = z.strictObject({
    identifier: required('Email, username or mobile'),
    code: z.string().trim().regex(/^[0-9]{6}$/, 'must be the 6-digit code from the email'),
    newPassword: password,
});

export const mfaCodeSchema = z.strictObject({
    code: z.string().trim().regex(/^[0-9]{6}$/, 'must be the 6-digit code from your app'),
});

export const mfaDisableSchema = z.strictObject({
    password,
    code: z.string().trim().regex(/^[0-9]{6}$/, 'must be the 6-digit code from your app'),
});
