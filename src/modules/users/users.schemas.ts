import { z } from 'zod';
import type { ListSpec } from '../../core/http/list-query';

const optionalText = (schema: z.ZodString) =>
    z
        .union([z.literal(''), schema])
        .transform((v) => (v === '' ? null : v))
        .nullable()
        .optional();

const email = optionalText(z.string().trim().toLowerCase().email('is not a valid email'));
const mobile = optionalText(z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'is not a valid mobile number'));

export const createUserSchema = z.strictObject({
    kind: z.enum(['admin', 'staff', 'student', 'guardian']),
    displayName: z.string().trim().min(2, 'must be at least 2 characters').max(120),
    username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9._-]{3,64}$/, 'use 3–64 letters, numbers, dots, dashes or underscores')
        .optional()
        .or(z.literal('').transform(() => undefined)),
    email,
    mobile,
    roleIds: z.array(z.string().uuid()).max(20).default([]),
});

export const updateUserSchema = z
    .strictObject({
        displayName: z.string().trim().min(2).max(120).optional(),
        email,
        mobile,
        status: z.enum(['active', 'disabled']).optional(),
        roleIds: z.array(z.string().uuid()).max(20).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const userFilters = {
    kind: z.enum(['admin', 'staff', 'student', 'guardian']),
    status: z.enum(['active', 'disabled']),
    role: z.string().regex(/^[a-z0-9-]+$/),
};

export const userListSpec: ListSpec<typeof userFilters> = {
    sortable: ['displayName', 'username', 'createdAt', 'lastLoginAt'],
    defaultSort: 'displayName',
    search: true,
    filters: userFilters,
};
