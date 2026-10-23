import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { defineAlert } from '../alerts/alerts.registry';
import { raise, raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { ALERTS } from '../alerts/alerts.settings';
import { classTeachersOf, holdersOf, parentsOf, staffOf, studentsOf } from '../alerts/recipients';
import { addDays, fmtDate } from '../alerts/format';
import { approvedLeaveOn } from '../leave/staff-leave.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { todayIST } from './attendance.settings';
import { dayOff } from './calendar.service';
import { staffDay } from './staff-attendance.service';
import { statuses } from './student-attendance.service';

/** Attendance alerts: absent today, absent several days running, staff not checked in, staff birthdays. */

const studentFields = [
    { key: 'student', label: 'Student', example: 'Manish Rana' },
    { key: 'class', label: 'Class', example: 'VII-B' },
];

defineAlert({
    key: 'attendance_absent',
    label: 'Absent today',
    description: 'When a student is marked absent in the day’s first register.',
    type: 'attendance',
    when: 'instant',
    recipients: [
        { key: 'parent', label: 'Parents' },
        { key: 'student', label: 'The student' },
    ],
    fields: [...studentFields, { key: 'date', label: 'Date', example: '23 Oct 2026' }, { key: 'status', label: 'Marked as', example: 'Absent' }],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent'],
        subject: '{{student}} is absent today',
        body: 'Dear {{name}},\n\n{{student}} ({{class}}) was marked {{status}} on {{date}}.\n\nIf you did not expect this, please contact the class teacher.',
        shortText: '{{school}}: {{student}} ({{class}}) was marked {{status}} on {{date}}.',
    },
    link: { parent: '/my-attendance', student: '/my-attendance' },
});

defineAlert({
    key: 'attendance_absent_streak',
    label: 'Absent several days in a row',
    description: 'Daily: students absent for the number of school days set in System Settings → Alerts.',
    type: 'attendance',
    when: 'daily',
    recipients: [
        { key: 'parent', label: 'Parents' },
        { key: 'class_teacher', label: 'Class teacher' },
    ],
    fields: [...studentFields, { key: 'days', label: 'Days absent in a row', example: '3' }, { key: 'since', label: 'Absent since', example: '20 Oct 2026' }],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent', 'class_teacher'],
        priority: 'important',
        subject: '{{student}} has been absent for {{days}} days',
        body: 'Dear {{name}},\n\n{{student}} ({{class}}) has been absent for {{days}} school days in a row, since {{since}}.\n\nPlease contact the school if anything is the matter.',
        shortText: '{{school}}: {{student}} ({{class}}) absent {{days}} days in a row since {{since}}.',
    },
    link: { parent: '/my-attendance', class_teacher: '/attendance' },
});

defineAlert({
    key: 'staff_not_checked_in',
    label: 'Staff not checked in',
    description: 'On school days, staff who haven’t checked in by the time set in System Settings → Alerts (not those on leave).',
    type: 'staff',
    when: 'daily',
    recipients: [{ key: 'staff', label: 'The staff member' }],
    fields: [{ key: 'date', label: 'Date', example: '23 Oct 2026' }, { key: 'time', label: 'Check-in time', example: '09:30' }],
    defaults: {
        enabled: false,
        channels: ['in_app'],
        recipients: ['staff'],
        subject: 'You haven’t checked in today',
        body: 'Dear {{name}},\n\nYou haven’t checked in today ({{date}}) by {{time}}. Please check in, or apply for leave.',
        shortText: '{{school}}: you haven’t checked in today by {{time}}.',
    },
    link: '/my-check-in',
});

defineAlert({
    key: 'staff_not_checked_in_summary',
    label: 'Staff not checked in (summary)',
    description: 'On school days, one list of staff who haven’t checked in, to those who look after staff attendance.',
    type: 'staff',
    when: 'daily',
    recipients: [{ key: 'office', label: 'Those who see staff attendance' }],
    fields: [{ key: 'date', label: 'Date', example: '23 Oct 2026' }, { key: 'count', label: 'How many', example: '4' }, { key: 'list', label: 'Their names', example: 'Rekha Raturi, Sanjay Singh' }],
    defaults: {
        enabled: false,
        channels: ['in_app'],
        recipients: ['office'],
        subject: '{{count}} staff not checked in today',
        body: 'Not checked in on {{date}}: {{list}}.',
        shortText: '{{school}}: {{count}} staff not checked in: {{list}}.',
    },
    link: '/attendance/staff',
});

defineAlert({
    key: 'staff_birthday',
    label: 'Staff birthday wish',
    description: 'Daily: a birthday wish to staff on their birthday.',
    type: 'staff',
    when: 'daily',
    recipients: [{ key: 'staff', label: 'The staff member' }],
    fields: [],
    defaults: {
        enabled: false,
        channels: ['in_app', 'email'],
        recipients: ['staff'],
        subject: 'Happy birthday, {{name}}!',
        body: 'Dear {{name}},\n\nEveryone at {{school}} wishes you a very happy birthday!',
        shortText: 'Happy birthday, {{name}}! Best wishes from {{school}}.',
    },
});

/** Called when a register is saved: parents of the absent students (once a day each). */
export const alertAbsentees = (section: { id: string; name: string; schoolClass: { name: string; shortName: string | null } }, date: string, absent: { studentId: string; name: string; status: string }[]) => {
    if (date !== todayIST()) return; // registers of past days don't alert
    for (const a of absent)
        raiseLater(
            'attendance_absent',
            { parent: () => parentsOf([a.studentId]), student: () => studentsOf([a.studentId]) },
            { student: a.name, class: sectionLabel(section), date: fmtDate(date), status: a.status },
            { dedupe: `absent:${a.studentId}:${date}`, sectionIds: [section.id] }
        );
};

defineDailyJob({
    key: 'attendance_absent_streak',
    run: async () => {
        const year = await currentYear();
        if (!year) return 'no session';
        const { n } = await getSettings({ n: ALERTS.absentDays });
        const today = todayIST();
        const list = await statuses();
        const absentIds = new Set(list.filter((s) => s.present === 0 && !s.excused).map((s) => s.id));
        const marks = await db.attendanceMark.findMany({
            where: { sheet: { date: { gte: new Date(`${addDays(today, -(n * 3 + 10))}T00:00:00Z`) }, section: { academicYearId: year.id } } },
            select: { studentId: true, statusId: true, sheet: { select: { date: true, sectionId: true } } },
        });
        // Per student and day: absent only if every register of the day says absent.
        const days = new Map<string, Map<string, boolean>>();
        const sectionOf = new Map<string, string>();
        for (const m of marks) {
            const d = m.sheet.date.toISOString().slice(0, 10);
            const byDay = days.get(m.studentId) ?? new Map<string, boolean>();
            byDay.set(d, (byDay.get(d) ?? true) && absentIds.has(m.statusId));
            days.set(m.studentId, byDay);
            sectionOf.set(m.studentId, m.sheet.sectionId);
        }
        const hits: { studentId: string; since: string; last: string }[] = [];
        for (const [studentId, byDay] of days) {
            const recent = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, n);
            if (recent.length === n && recent.every(([, absent]) => absent) && recent[0][0] >= addDays(today, -3)) hits.push({ studentId, since: recent[n - 1][0], last: recent[0][0] });
        }
        if (!hits.length) return '0 students';
        const students = new Map((await db.student.findMany({ where: { id: { in: hits.map((h) => h.studentId) }, status: 'active' }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => [s.id, fullName(s)]));
        const sections = new Map((await db.section.findMany({ where: { id: { in: [...new Set(hits.map((h) => sectionOf.get(h.studentId)!))] } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } })).map((s) => [s.id, sectionLabel(s)]));
        let sent = 0;
        for (const h of hits) {
            if (!students.has(h.studentId)) continue;
            const sectionId = sectionOf.get(h.studentId)!;
            await raise(
                'attendance_absent_streak',
                { parent: () => parentsOf([h.studentId]), class_teacher: () => classTeachersOf([h.studentId]) },
                { student: students.get(h.studentId)!, class: sections.get(sectionId) ?? '', days: String(n), since: fmtDate(h.since) },
                { dedupe: `streak:${h.studentId}:${h.last}`, sectionIds: [sectionId] }
            );
            sent++;
        }
        return `${sent} students`;
    },
});

defineDailyJob({
    key: 'staff_not_checked_in',
    at: async () => (await getSettings({ t: ALERTS.checkInBy })).t,
    run: async () => {
        const today = todayIST();
        if (await dayOff(today, 'staff')) return 'not a working day';
        const { t } = await getSettings({ t: ALERTS.checkInBy });
        const day = await staffDay({ date: today });
        const missing: (typeof day.staff)[number][] = [];
        for (const s of day.staff) if ((!s.record || (!s.record.checkIn && !s.record.status)) && !(await approvedLeaveOn(s.id, today))) missing.push(s);
        if (!missing.length) return '0 staff';
        await raise('staff_not_checked_in', { staff: () => staffOf(missing.map((m) => m.id)) }, { date: fmtDate(today), time: t }, { dedupe: `checkin:${today}` });
        await raise('staff_not_checked_in_summary', { office: () => holdersOf('attendance.staff') }, { date: fmtDate(today), count: String(missing.length), list: missing.map((m) => m.name).join(', ') }, { dedupe: `checkin-summary:${today}` });
        return `${missing.length} staff`;
    },
});

defineDailyJob({
    key: 'staff_birthday',
    run: async () => {
        const today = todayIST();
        const md = today.slice(5);
        const staff = await db.staff.findMany({ where: { status: 'working', dateOfBirth: { not: null } }, select: { id: true, dateOfBirth: true } });
        const ids = staff.filter((s) => s.dateOfBirth!.toISOString().slice(5, 10) === md).map((s) => s.id);
        if (!ids.length) return '0 staff';
        await raise('staff_birthday', { staff: () => staffOf(ids) }, {}, { dedupe: `birthday:${today}` });
        return `${ids.length} staff`;
    },
});
