import { db } from '../../core/db';
import { defineWidget } from '../dashboard/dashboard.registry';
import { onQueuePass } from '../alerts/queue';
import { runAsSystem, runAsTenant } from '../../core/context';
import { myTests, submitExpired } from './tests.service';

/** Dashboard widgets of online tests, and submitting attempts whose time ran out. */

defineWidget({
    key: 'my_tests',
    label: 'Online tests',
    description: 'A student’s (or each child’s) online tests open now or coming, and new results.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/my-tests',
    permissions: ['test.take'],
    cacheSeconds: 60,
    async load({ userId }) {
        const all = await myTests(userId);
        if (!all.length) return { hidden: true, items: [], empty: '' };
        const items = all.flatMap((c) =>
            c.tests
                .filter((t) => t.state === 'open' || t.state === 'upcoming' || (t.result && t.state === 'results'))
                .slice(0, 6)
                .map((t) => ({
                    title: `${t.subject}: ${t.title}`,
                    sub: `${all.length > 1 ? `${c.student.name} · ` : ''}${t.result ? `scored ${t.result.score} / ${t.result.totalMarks}` : t.state === 'open' ? (t.attempt ? 'taken' : 'open now') : `opens ${new Date(t.startsAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`}`,
                    href: '/my-tests',
                    tone: (t.state === 'open' && !t.attempt ? 'warn' : 'neutral') as 'warn' | 'neutral',
                }))
        );
        return { items, empty: 'No online tests right now.' };
    },
});

defineWidget({
    key: 'tests_to_mark',
    label: 'Tests to mark',
    description: 'Submitted online tests with written answers still to mark.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/tests',
    permissions: ['test.mark'],
    cacheSeconds: 120,
    async load({ userId }) {
        const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
        if (!staff) return { hidden: true, value: '' };
        const waiting = await db.testAttempt.count({ where: { status: 'submitted', test: { staffId: staff.id } } });
        return { value: waiting, caption: 'answer sheets waiting to be marked', tone: waiting > 30 ? 'warn' : 'neutral' };
    },
});

onQueuePass(async () => {
    const schools = await runAsSystem(() => db.testAttempt.groupBy({ by: ['tenantId'], where: { status: 'in_progress', dueAt: { lt: new Date(Date.now() - 30_000) } } }));
    for (const s of schools) await runAsTenant(s.tenantId, submitExpired);
});
