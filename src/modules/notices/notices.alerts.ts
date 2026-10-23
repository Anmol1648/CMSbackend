import { db } from '../../core/db';
import { defineAlert } from '../alerts/alerts.registry';
import { raiseLater } from '../alerts/deliver';
import { usersOf } from '../alerts/recipients';
import { membersOf, pickAudience, population } from './audience';

/** A notice published: to the people it is for (in-app by default; email too if the school ticks it). */

defineAlert({
    key: 'notice_published',
    label: 'New notice',
    description: 'When a notice is published: to everyone it is meant for. Important notices go as important.',
    type: 'notices',
    when: 'instant',
    recipients: [{ key: 'audience', label: 'The people it is for' }],
    fields: [
        { key: 'title', label: 'Title', example: 'School closed on Monday' },
        { key: 'excerpt', label: 'The start of the notice', example: 'Due to heavy rain the school will remain closed…' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['audience'],
        subject: 'Notice: {{title}}',
        body: 'Dear {{name}},\n\n{{excerpt}}\n\nRead the full notice on the notice board.',
        shortText: '{{school}} notice: {{title}}',
    },
    link: '/notices',
});

export const alertNotice = (noticeId: string) => {
    void (async () => {
        const n = await db.notice.findFirst({ where: { id: noticeId } });
        if (!n || n.status !== 'published' || (n.publishAt && n.publishAt > new Date(Date.now() + 60_000))) return;
        const people = membersOf(pickAudience(n), await population());
        const excerpt = n.body.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
        raiseLater(
            'notice_published',
            { audience: () => usersOf(people.map((p) => p.userId)) },
            { title: n.title, excerpt: excerpt.length > 300 ? `${excerpt.slice(0, 300)}…` : excerpt },
            { dedupe: `notice:${n.id}`, ...(n.important ? { priority: 'important' } : {}) }
        );
    })();
};
