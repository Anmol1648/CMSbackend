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

const optionalText = (schema: z.ZodString) =>
    z
        .union([z.literal(''), schema])
        .transform((v) => (v === '' ? null : v))
        .nullable()
        .optional();

/** My account → Details. Which fields may change is a school setting (accounts.self_edit). */
export const updateMyDetailsSchema = z
    .strictObject({
        displayName: z.string().trim().min(2, 'must be at least 2 characters').max(120).optional(),
        email: optionalText(z.string().trim().toLowerCase().email('is not a valid email')),
        mobile: optionalText(z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid mobile number')),
        currentPassword: z.string().max(128).optional(),
    })
    .refine((v) => v.displayName !== undefined || v.email !== undefined || v.mobile !== undefined, { message: 'Nothing to update' });
