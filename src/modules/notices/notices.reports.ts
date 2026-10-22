import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { describeAudience, membersOf, population } from './audience';

/** Notice and event reports (Report Center). */

registerReportCategory('Notices & Events', 50);

const showDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const check = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
};

defineReport({
    key: 'notice_reads',
    category: 'Notices & Events',
    label: 'Notices: who has read them',
    description: 'Each notice published in a period: who it was for, how many have read it and acknowledged it.',
    permissions: ['notice.reports', 'notice.publish'],
    orientation: 'landscape',
    filters: [
        { key: 'from', label: 'Published from', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'published', label: 'Published', type: 'date', width: 0.9 },
        { key: 'title', label: 'Notice', type: 'text', width: 2.4 },
        { key: 'category', label: 'Category', type: 'text', width: 1 },
        { key: 'audience', label: 'For', type: 'text', width: 1.8 },
        { key: 'people', label: 'People', type: 'number', width: 0.6 },
        { key: 'read', label: 'Read', type: 'number', width: 0.6 },
        { key: 'percent', label: 'Read %', type: 'number', width: 0.6 },
        { key: 'ack', label: 'Acknowledged', type: 'text', width: 0.8 },
    ],
    async run(f) {
        check(f);
        const rows = await db.notice.findMany({ where: { status: 'published', publishAt: { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) } }, orderBy: { publishAt: 'asc' } });
        const [everyone, cats, reads] = await Promise.all([
            population(),
            db.masterValue.findMany({ where: { master: 'notice_category' }, select: { id: true, name: true } }),
            db.noticeRead.findMany({ where: { noticeId: { in: rows.map((n) => n.id) } }, select: { noticeId: true, userId: true, acknowledgedAt: true } }),
        ]);
        const out = [];
        for (const n of rows) {
            const members = membersOf(n, everyone);
            const ids = new Set(members.map((m) => m.userId));
            const mine = reads.filter((r) => r.noticeId === n.id && ids.has(r.userId));
            out.push({
                published: isoOf(n.publishAt!),
                title: n.title,
                category: cats.find((c) => c.id === n.categoryId)?.name ?? null,
                audience: await describeAudience(n),
                people: members.length,
                read: mine.length,
                percent: members.length ? Math.round((mine.length / members.length) * 100) : null,
                ack: n.needsAck ? String(mine.filter((r) => r.acknowledgedAt).length) : '—',
            });
        }
        return { rows: out, subtitle: `${showDay(f.from)} – ${showDay(f.to)}` };
    },
});

defineReport({
    key: 'events_list',
    category: 'Notices & Events',
    label: 'School calendar (events)',
    description: 'The events of a period with their dates, times, venue and who they are for. Print it for the notice board.',
    permissions: ['event.manage', 'notice.reports', 'notice.publish'],
    orientation: 'portrait',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'sessionEnd' },
    ],
    columns: [
        { key: 'date', label: 'Date', type: 'text', width: 1.3 },
        { key: 'time', label: 'Time', type: 'text', width: 0.8 },
        { key: 'title', label: 'Event', type: 'text', width: 2 },
        { key: 'type', label: 'Type', type: 'text', width: 1 },
        { key: 'venue', label: 'Venue', type: 'text', width: 1 },
        { key: 'audience', label: 'For', type: 'text', width: 1.4 },
    ],
    async run(f) {
        check(f);
        const to = f.to;
        const rows = await db.schoolEvent.findMany({ where: { status: 'scheduled', startDate: { lte: dayDate(to) }, endDate: { gte: dayDate(f.from) } }, orderBy: [{ startDate: 'asc' }, { startTime: 'asc' }] });
        const types = new Map((await db.masterValue.findMany({ where: { master: 'event_type' }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
        const out = [];
        for (const e of rows) {
            const a = isoOf(e.startDate);
            const b = isoOf(e.endDate);
            out.push({
                groupKey: a.slice(0, 7),
                groupLabel: new Date(`${a}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
                date: a === b ? showDay(a) : `${showDay(a)} – ${showDay(b)}`,
                time: e.startTime ? `${e.startTime}${e.endTime ? `–${e.endTime}` : ''}` : 'All day',
                title: `${e.title}${e.holidayFor !== 'none' ? ' (holiday)' : ''}`,
                type: e.typeId ? (types.get(e.typeId) ?? null) : null,
                venue: e.venue,
                audience: await describeAudience(e),
            });
        }
        return { rows: out, subtitle: `${showDay(f.from)} – ${showDay(to)}`, groupedBy: 'Month' };
    },
});
