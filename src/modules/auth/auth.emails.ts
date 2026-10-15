import { registerEmailTemplate } from '../../core/mail/templates';

/** Emails sent by sign-in flows. Schools can reword them on Setup → Email Templates. */

export const PASSWORD_RESET_EMAIL = registerEmailTemplate({
    key: 'password_reset',
    label: 'Password reset code',
    description: 'Sent when someone uses "Forgot password?" on the sign-in page.',
    placeholders: [
        { key: 'name', label: "Person's name", example: 'Riya Sharma' },
        { key: 'code', label: 'Reset code', example: '482913', style: 'code' },
        { key: 'minutes', label: 'Minutes the code is valid', example: '10' },
    ],
    required: ['code'],
    subject: '{{school}}: your password reset code',
    body: [
        'Hello {{name}},',
        'Use this code to choose a new password:',
        '{{code}}',
        "It is valid for {{minutes}} minutes. If you didn't ask for this, you can ignore this email; your password stays the same.",
    ].join('\n\n'),
});

export const WELCOME_EMAIL = registerEmailTemplate({
    key: 'welcome',
    label: 'New account (sign-in details)',
    description: 'Sent when an account is created for someone who has an email address.',
    placeholders: [
        { key: 'name', label: "Person's name", example: 'Riya Sharma' },
        { key: 'username', label: 'Username', example: 'riya.sharma' },
        { key: 'password', label: 'First password', example: 'kmrt-4827-xbqe', style: 'code' },
    ],
    required: ['username', 'password'],
    subject: '{{school}}: your sign-in details',
    body: [
        'Hello {{name}},',
        'An account has been created for you at {{school}}.',
        'Username: {{username}}\nFirst password:',
        '{{password}}',
        "You'll be asked to choose your own password when you first sign in.",
    ].join('\n\n'),
});
