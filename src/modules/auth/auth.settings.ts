import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** Sign-in, security and password settings (System Settings → Login / Security / Passwords / Accounts). */

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const LOGIN = {
    identifiers: defineSetting<('email' | 'username' | 'mobile')[]>({
        key: 'login.identifiers',
        group: 'Login',
        label: 'People can sign in with',
        help: 'Which identifiers the sign-in box accepts.',
        type: 'multiselect',
        default: ['email', 'username', 'mobile'],
        schema: z.array(z.enum(['email', 'username', 'mobile'])).min(1, 'choose at least one'),
        options: [
            { value: 'email', label: 'Email' },
            { value: 'username', label: 'Username' },
            { value: 'mobile', label: 'Mobile number' },
        ],
    }),
    showForgotPassword: defineSetting<boolean>({
        key: 'login.show_forgot_password',
        group: 'Login',
        label: 'Allow "Forgot password" by email',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
};

export type SelfEditField = 'photo' | 'name' | 'email' | 'mobile';

export const SECURITY = {
    lockoutAttempts: defineSetting<number>({
        key: 'security.lockout_attempts',
        group: 'Security',
        label: 'Lock an account after this many wrong passwords',
        type: 'number',
        default: 5,
        schema: int(3, 20),
    }),
    lockoutMinutes: defineSetting<number>({
        key: 'security.lockout_minutes',
        group: 'Security',
        label: 'Lock for (minutes)',
        type: 'number',
        default: 15,
        schema: int(1, 1440),
    }),
    accessTokenMinutes: defineSetting<number>({
        key: 'security.access_token_minutes',
        group: 'Security',
        label: 'Sign-in check interval (minutes)',
        help: 'How long a sign-in token lasts before it is silently renewed. Shorter = sign-outs take effect sooner.',
        type: 'number',
        default: 15,
        schema: int(5, 60),
    }),
    sessionDays: defineSetting<number>({
        key: 'security.session_days',
        group: 'Security',
        label: 'Stay signed in for (days)',
        type: 'number',
        default: 7,
        schema: int(1, 90),
    }),
    rememberMeDays: defineSetting<number>({
        key: 'security.remember_me_days',
        group: 'Security',
        label: '"Keep me signed in" lasts (days)',
        type: 'number',
        default: 30,
        schema: int(1, 365),
    }),
    mfaPolicy: defineSetting<'off' | 'optional'>({
        key: 'security.mfa_policy',
        group: 'Security',
        label: 'Two-step sign-in (authenticator app)',
        help: '"Optional" lets each user turn it on for their own account.',
        type: 'select',
        default: 'optional',
        schema: z.enum(['off', 'optional']),
        options: [
            { value: 'off', label: 'Off for everyone' },
            { value: 'optional', label: 'Optional per user' },
        ],
    }),
};

export const PASSWORDS = {
    minLength: defineSetting<number>({ key: 'passwords.min_length', group: 'Passwords', label: 'Minimum length', type: 'number', default: 8, schema: int(6, 64) }),
    requireLetter: defineSetting<boolean>({ key: 'passwords.require_letter', group: 'Passwords', label: 'Must contain a letter', type: 'boolean', default: true, schema: z.boolean() }),
    requireNumber: defineSetting<boolean>({ key: 'passwords.require_number', group: 'Passwords', label: 'Must contain a number', type: 'boolean', default: true, schema: z.boolean() }),
    requireMixedCase: defineSetting<boolean>({ key: 'passwords.require_mixed_case', group: 'Passwords', label: 'Must mix upper and lower case', type: 'boolean', default: false, schema: z.boolean() }),
    requireSymbol: defineSetting<boolean>({ key: 'passwords.require_symbol', group: 'Passwords', label: 'Must contain a symbol', type: 'boolean', default: false, schema: z.boolean() }),
    expiryDays: defineSetting<number>({
        key: 'passwords.expiry_days',
        group: 'Passwords',
        label: 'Ask for a new password every (days)',
        help: '0 = never.',
        type: 'number',
        default: 0,
        schema: int(0, 365),
    }),
    rememberLast: defineSetting<number>({
        key: 'passwords.remember_last',
        group: 'Passwords',
        label: "Can't reuse the last N passwords",
        type: 'number',
        default: 3,
        schema: int(0, 24),
    }),
    resetCodeMinutes: defineSetting<number>({
        key: 'passwords.reset_code_minutes',
        group: 'Passwords',
        label: 'Password reset code is valid for (minutes)',
        type: 'number',
        default: 10,
        schema: int(5, 60),
    }),
};

export const ACCOUNTS = {
    firstPassword: defineSetting<'random' | 'date_of_birth'>({
        key: 'accounts.first_password',
        group: 'Accounts',
        label: 'First password for new logins',
        help: 'Either way, the person must change it at first sign-in.',
        type: 'select',
        default: 'random',
        schema: z.enum(['random', 'date_of_birth']),
        options: [
            { value: 'random', label: 'Random (shown once)' },
            { value: 'date_of_birth', label: 'Date of birth (DDMMYYYY)' },
        ],
    }),
    welcomeEmail: defineSetting<boolean>({
        key: 'accounts.welcome_email',
        group: 'Accounts',
        label: 'Email the sign-in details to new users who have an email address',
        type: 'boolean',
        default: true,
        schema: z.boolean(),
    }),
    selfEdit: defineSetting<SelfEditField[]>({
        key: 'accounts.self_edit',
        group: 'Accounts',
        label: 'People can change these on their own account (My account)',
        help: 'Changing email or mobile asks for their current password. The school office can always change them on the Users screen.',
        type: 'multiselect',
        default: ['photo', 'email', 'mobile'],
        schema: z.array(z.enum(['photo', 'name', 'email', 'mobile'])),
        options: [
            { value: 'photo', label: 'Photo' },
            { value: 'name', label: 'Name' },
            { value: 'email', label: 'Email' },
            { value: 'mobile', label: 'Mobile number' },
        ],
    }),
};
