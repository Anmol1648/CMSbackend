import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineAlert } from '../alerts/alerts.registry';
import { raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { parentsOf, staffOf } from '../alerts/recipients';
import { PTM } from './ptm.settings';
import { showDay, showTime, sittingBySection } from './ptm.service';

/** PTM alerts (Alerts → Built-in Alerts) and the reminder before the day. */

const families = [
    { key: 'parent', label: 'Parents' },
    { key: 'student', label: 'Students' },
];
const base = [
    { key: 'title', label: 'PTM', example: 'PTM after Half-yearly exams' },
    { key: 'date', label: 'Date', example: 'Sat, 7 Nov 2026' },
];

defineAlert({ key: 'ptm_announced', label: 'PTM announced', description: 'When a PTM is published: to the families of its sections (and its teachers).', type: 'notices', when: 'instant', recipients: [...families, { key: 'teacher', label: 'Teachers who sit' }], fields: [...base, { key: 'time', label: 'Time', example: '9:00 am – 1:00 pm' }, { key: 'how', label: 'Where', example: 'at school' }, { key: 'booking', label: 'Booking line', example: 'Please book a time with each teacher on the PTM page.' }], defaults: { enabled: true, channels: ['in_app', 'email'], recipients: ['parent', 'teacher'], subject: 'PTM on {{date}}', body: 'Dear {{name}},\n\n{{title}} is on {{date}}, {{time}}, {{how}}.\n\n{{booking}}', shortText: '{{school}}: PTM on {{date}}, {{time}}. {{booking}}' }, link: { parent: '/my-ptm', student: '/my-ptm', teacher: '/ptm/meet' } });
defineAlert({ key: 'ptm_reminder', label: 'PTM reminder', description: 'Daily, before the PTM (days in System Settings → PTM): parents get their booked times, or a reminder to book.', type: 'notices', when: 'daily', recipients: families, fields: [...base, { key: 'list', label: 'Their meetings', example: '- 9:20 am: Deepak Rautela (Shubham)' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['parent'], subject: 'PTM on {{date}}', body: 'Dear {{name}},\n\nA reminder: {{title}} is on {{date}}.\n\n{{list}}', shortText: '{{school}}: PTM on {{date}}. {{list}}' }, link: '/my-ptm' });
defineAlert({ key: 'ptm_cancelled', label: 'PTM cancelled', description: 'When a published PTM is cancelled.', type: 'notices', when: 'instant', recipients: families, fields: [...base, { key: 'reason', label: 'Why', example: 'Heavy rain warning' }], defaults: { enabled: true, channels: ['in_app', 'email'], recipients: ['parent'], priority: 'important', subject: 'PTM on {{date}} is cancelled', body: 'Dear {{name}},\n\n{{title}} on {{date}} is cancelled: {{reason}}. A new date will be shared.', shortText: '{{school}}: PTM on {{date}} cancelled ({{reason}}).' }, link: '/my-ptm' });
defineAlert({ key: 'ptm_remarks', label: 'PTM remarks available', description: 'When a PTM is closed: to families who met teachers whose remarks are shared.', type: 'notices', when: 'instant', recipients: families, fields: base, defaults: { enabled: true, channels: ['in_app'], recipients: ['parent'], subject: 'Teachers’ remarks from the PTM', body: 'Dear {{name}},\n\nThe teachers’ remarks from {{title}} ({{date}}) are on the PTM page.', shortText: '{{school}}: PTM remarks are on the app.' }, link: '/my-ptm' });
defineAlert({ key: 'ptm_teacher_day', label: 'PTM: teacher’s day plan', description: 'Daily, the day before: each teacher gets their booked meetings.', type: 'notices', when: 'daily', recipients: [{ key: 'teacher', label: 'Teachers who sit' }], fields: [...base, { key: 'list', label: 'Their meetings', example: '- 9:20 am: Shubham Nautiyal (VII-B)' }, { key: 'count', label: 'How many', example: '12' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['teacher'], subject: 'PTM tomorrow: {{count}} meetings', body: 'Dear {{name}},\n\nYour meetings at {{title}} ({{date}}):\n\n{{list}}', shortText: '{{school}}: PTM {{date}}: {{count}} meetings.' }, link: '/ptm/meet' });

defineDailyJob({
    key: 'ptm_reminder',
    run: async () => {
        const { days } = await getSettings({ days: PTM.remindDays });
        if (!days) return 'off';
        const day = isoOf(new Date(dayDate(todayIST()).getTime() + days * 86_400_000));
        const ptms = await db.ptm.findMany({ where: { status: 'published', date: dayDate(day) } });
        let families = 0;
        for (const p of ptms) {
            const [enrol, meetings] = await Promise.all([
                db.enrolment.findMany({ where: { academicYearId: p.academicYearId, sectionId: { in: p.sectionIds }, student: { status: 'active' } }, select: { student: { select: { id: true, firstName: true } } } }),
                db.ptmMeeting.findMany({ where: { ptmId: p.id, status: 'booked', slot: { not: null } }, orderBy: { slot: 'asc' } }),
            ]);
            const staff = new Map((await db.staff.findMany({ where: { id: { in: meetings.map((m) => m.staffId) } }, select: { id: true, firstName: true, lastName: true } })).map((s) => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ')]));
            for (const e of enrol) {
                const mine = meetings.filter((m) => m.studentId === e.student.id);
                const list = mine.length ? `Your times:\n${mine.map((m) => `- ${showTime(m.slot!)}: ${staff.get(m.staffId) ?? ''} (${e.student.firstName})`).join('\n')}` : p.booking ? `You haven’t booked a time for ${e.student.firstName} yet: please book on the PTM page.` : `Come any time between ${showTime(p.startTime)} and ${showTime(p.endTime)}.`;
                raiseLater('ptm_reminder', { parent: () => parentsOf([e.student.id]) }, { title: p.title, date: showDay(p.date), list }, { dedupe: `ptm-remind:${p.id}:${e.student.id}` });
                families++;
            }
        }
        return `${families} families`;
    },
});

defineDailyJob({
    key: 'ptm_teacher_day',
    run: async () => {
        const day = isoOf(new Date(dayDate(todayIST()).getTime() + 86_400_000));
        const ptms = await db.ptm.findMany({ where: { status: 'published', date: dayDate(day) } });
        let teachers = 0;
        for (const p of ptms) {
            const { bySection } = await sittingBySection(p);
            const ids = [...new Set([...bySection.values()].flatMap((m) => [...m.keys()]))];
            const meetings = await db.ptmMeeting.findMany({ where: { ptmId: p.id, status: 'booked', slot: { not: null } }, orderBy: { slot: 'asc' } });
            const students = new Map((await db.student.findMany({ where: { id: { in: meetings.map((m) => m.studentId) } }, select: { id: true, firstName: true, lastName: true } })).map((s) => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ')]));
            for (const staffId of ids) {
                const mine = meetings.filter((m) => m.staffId === staffId);
                raiseLater('ptm_teacher_day', { teacher: () => staffOf([staffId]) }, { title: p.title, date: showDay(p.date), count: String(mine.length), list: mine.length ? mine.map((m) => `- ${showTime(m.slot!)}: ${students.get(m.studentId) ?? ''}`).join('\n') : 'No bookings yet; walk-ins may come.' }, { dedupe: `ptm-day:${p.id}:${staffId}` });
                teachers++;
            }
        }
        return `${teachers} teachers`;
    },
});
