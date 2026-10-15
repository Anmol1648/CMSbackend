import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { testOutbox } from '../src/core/mail';
import { makeTenant, makeUser, resetDatabase, resetRateLimits, setPasswordFor, tokenFor } from './helpers';

const ORIGIN = 'https://alpha.test.in';
let alpha: Awaited<ReturnType<typeof makeTenant>>;
let superAdmin: string;
let teacher: string;
let teacherUser: { id: string; tenantId: string };

const as = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Origin', ORIGIN).set('Authorization', token),
    post: (p: string, body: object = {}) => request(app).post(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    put: (p: string, body: object) => request(app).put(p).set('Origin', ORIGIN).set('Authorization', token).send(body),
    del: (p: string) => request(app).delete(p).set('Origin', ORIGIN).set('Authorization', token),
});

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in');
    superAdmin = tokenFor({ id: alpha.admin.id, tenantId: alpha.tenant.id });
    teacherUser = await makeUser(alpha.tenant.id, 'teacher.one', 'teacher');
    teacher = tokenFor(teacherUser);
    await runAsTenant(alpha.tenant.id, () => db.user.update({ where: { id: teacherUser.id }, data: { email: 'teacher@alpha.test.in' } }));
    await setPasswordFor(teacherUser, 'Teacher-pass-1');
});

beforeEach(() => {
    testOutbox.length = 0;
});

describe('email templates', () => {
    it('lists the emails the system sends', async () => {
        const res = await as(superAdmin).get('/api/email-templates');
        expect(res.status).toBe(200);
        expect(res.body.data.map((t: { key: string }) => t.key)).toEqual(['password_reset', 'welcome']);
        expect(res.body.data.every((t: { isCustom: boolean }) => !t.isCustom)).toBe(true);
    });

    it('previews in the school layout with example values, including unsaved wording', async () => {
        const res = await as(superAdmin).post('/api/email-templates/password_reset/preview');
        expect(res.status).toBe(200);
        expect(res.body.data.subject).toBe('Alpha School: your password reset code');
        expect(res.body.data.html).toContain('482913');
        expect(res.body.data.html).toContain('Alpha School');
        expect(res.body.data.html).toContain("automatic message from Alpha School's school management system");

        const draft = await as(superAdmin).post('/api/email-templates/password_reset/preview', { subject: 'Code for {{name}}', body: 'Your code: {{code}} <b>not bold</b>' });
        expect(draft.body.data.subject).toBe('Code for Riya Sharma');
        expect(draft.body.data.html).toContain('&lt;b&gt;not bold&lt;/b&gt;'); // typed HTML is shown as text, never run
    });

    it('refuses wording that drops a required field or uses unknown ones', async () => {
        const missing = await as(superAdmin).put('/api/email-templates/password_reset', { subject: 'Hello', body: 'No code here' });
        expect(missing.status).toBe(400);
        expect(missing.body.error.details).toEqual([{ field: 'body', message: 'must contain {{code}}' }]);
        const unknown = await as(superAdmin).put('/api/email-templates/password_reset', { subject: 'Hi {{nickname}}', body: '{{code}}' });
        expect(unknown.body.error.details).toEqual([{ field: 'subject', message: '{{nickname}} is not a field of this email' }]);
    });

    it("uses the school's wording for real emails, and can go back to the default", async () => {
        const saved = await as(superAdmin).put('/api/email-templates/password_reset', { subject: '{{school}} reset code: {{code}}', body: 'Dear {{name}},\n\n{{code}}\n\nValid {{minutes}} min.' });
        expect(saved.status).toBe(200);
        expect(saved.body.data.isCustom).toBe(true);

        await resetRateLimits();
        await request(app).post('/api/auth/forgot-password').set('Origin', ORIGIN).send({ identifier: 'teacher.one' });
        expect(testOutbox).toHaveLength(1);
        expect(testOutbox[0].subject).toMatch(/^Alpha School reset code: \d{6}$/);
        expect(testOutbox[0].text).toMatch(/^Dear teacher\.one,/);
        expect(testOutbox[0].text).toContain('Valid 10 min.');
        expect(testOutbox[0].html).toContain('Valid <b>10</b> min.'); // values stand out in the HTML version

        const audit = await runAsTenant(alpha.tenant.id, () => db.auditLog.findFirst({ where: { entity: 'email_template', entityId: 'password_reset' } }));
        expect(audit?.changes).toMatchObject({ subject: ['{{school}}: your password reset code', '{{school}} reset code: {{code}}'] });

        const reset = await as(superAdmin).del('/api/email-templates/password_reset');
        expect(reset.body.data).toMatchObject({ isCustom: false, subject: '{{school}}: your password reset code' });
    });

    it('sends a test email to my own address', async () => {
        const noEmail = await as(superAdmin).post('/api/email-templates/welcome/test');
        expect(noEmail.status).toBe(400);
        await runAsTenant(alpha.tenant.id, () => db.user.update({ where: { id: alpha.admin.id }, data: { email: 'admin@alpha.test.in' } }));
        const res = await as(superAdmin).post('/api/email-templates/welcome/test');
        expect(res.status).toBe(200);
        expect(testOutbox[0]).toMatchObject({ to: 'admin@alpha.test.in', subject: '[Test] Alpha School: your sign-in details' });
        expect(testOutbox[0].text).toContain('kmrt-4827-xbqe');
    });

    it('needs settings permissions', async () => {
        expect((await as(teacher).get('/api/email-templates')).status).toBe(403);
        expect((await as(teacher).put('/api/email-templates/welcome', { subject: 'x', body: '{{username}} {{password}}' })).status).toBe(403);
    });
});
