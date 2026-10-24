import { db } from '../../core/db';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';
import { myMeetings, myPtms, showDay, showTime } from './ptm.service';

/** PTM reports (Report Center) and dashboard widgets. */

registerReportCategory('PTM', 46);

const latest = async (id?: string) => (id ? db.ptm.findFirst({ where: { id } }) : db.ptm.findFirst({ where: { status: { in: ['done', 'published'] } }, orderBy: { date: 'desc' } }));
const filterWithOptions = () => ({ key: 'ptm', label: 'PTM (empty = the latest)', type: 'ptm' as const });

const sectionsOf = async (ids: string[]) => db.section.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } });

defineReport({
    key: 'ptm_attendance',
    category: 'PTM',
    label: 'PTM attendance by section',
    description: 'For a PTM: each section’s students, how many families booked, came and didn’t come.',
    permissions: ['ptm.manage'],
    orientation: 'portrait',
    filters: [filterWithOptions()],
    columns: [
        { key: 'section', label: 'Section', type: 'text', width: 1.2 },
        { key: 'students', label: 'Students', type: 'number', width: 0.8, total: true },
        { key: 'booked', label: 'Families booked', type: 'number', width: 0.9, total: true },
        { key: 'came', label: 'Came', type: 'number', width: 0.7, total: true },
        { key: 'percent', label: 'Came %', type: 'number', width: 0.7 },
    ],
    async run(f) {
        const p = await latest(f.ptm || undefined);
        if (!p) return { rows: [] };
        const [enrol, meetings, sections] = await Promise.all([db.enrolment.findMany({ where: { academicYearId: p.academicYearId, sectionId: { in: p.sectionIds }, student: { status: 'active' } }, select: { sectionId: true, studentId: true } }), db.ptmMeeting.findMany({ where: { ptmId: p.id, status: { not: 'cancelled' } }, select: { studentId: true, status: true, slot: true } }), sectionsOf(p.sectionIds)]);
        return {
            subtitle: `${p.title} · ${showDay(p.date)}`,
            rows: sections
                .sort((a, b) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.sortOrder - b.sortOrder)
                .map((s) => {
                    const ids = new Set(enrol.filter((e) => e.sectionId === s.id).map((e) => e.studentId));
                    const booked = new Set(meetings.filter((m) => ids.has(m.studentId) && m.slot).map((m) => m.studentId)).size;
                    const came = new Set(meetings.filter((m) => ids.has(m.studentId) && m.status === 'attended').map((m) => m.studentId)).size;
                    return { section: sectionLabel(s), students: ids.size, booked, came, percent: ids.size ? Math.round((came / ids.size) * 1000) / 10 : null };
                }),
        };
    },
});

defineReport({
    key: 'ptm_not_came',
    category: 'PTM',
    label: 'Families who didn’t come to the PTM',
    description: 'Students whose parents met no teacher at a PTM (booked and didn’t come, or didn’t book): to call or meet later.',
    permissions: ['ptm.manage'],
    orientation: 'portrait',
    about: 'student',
    filters: [filterWithOptions()],
    columns: [
        { key: 'section', label: 'Section', type: 'text', width: 0.8 },
        { key: 'roll', label: 'Roll', type: 'number', width: 0.5 },
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'state', label: 'Booking', type: 'text', width: 1.1 },
    ],
    async run(f) {
        const p = await latest(f.ptm || undefined);
        if (!p) return { rows: [] };
        const [enrol, meetings, sections] = await Promise.all([db.enrolment.findMany({ where: { academicYearId: p.academicYearId, sectionId: { in: p.sectionIds }, student: { status: 'active' } }, select: { sectionId: true, rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } }), db.ptmMeeting.findMany({ where: { ptmId: p.id, status: { not: 'cancelled' } }, select: { studentId: true, status: true, slot: true } }), sectionsOf(p.sectionIds)]);
        const label = new Map(sections.map((s) => [s.id, sectionLabel(s)]));
        const order = new Map(sections.map((s) => [s.id, s.schoolClass.sortOrder * 100 + s.sortOrder]));
        return {
            subtitle: `${p.title} · ${showDay(p.date)}`,
            rows: enrol
                .filter((e) => !meetings.some((m) => m.studentId === e.student.id && m.status === 'attended'))
                .sort((a, b) => (order.get(a.sectionId) ?? 0) - (order.get(b.sectionId) ?? 0) || (a.rollNumber ?? 999) - (b.rollNumber ?? 999))
                .map((e) => ({ studentId: e.student.id, section: label.get(e.sectionId) ?? '', roll: e.rollNumber, student: fullName(e.student), admissionNo: e.student.admissionNo, state: meetings.some((m) => m.studentId === e.student.id && m.slot) ? 'Booked, didn’t come' : 'Didn’t book' })),
        };
    },
});

defineReport({
    key: 'ptm_remarks',
    category: 'PTM',
    label: 'PTM remarks by student',
    description: 'Every teacher’s remarks and action points from a PTM, by student.',
    permissions: ['ptm.manage'],
    orientation: 'landscape',
    about: 'student',
    filters: [filterWithOptions()],
    columns: [
        { key: 'student', label: 'Student', type: 'text', width: 1.4 },
        { key: 'section', label: 'Section', type: 'text', width: 0.7 },
        { key: 'teacher', label: 'Teacher', type: 'text', width: 1.2 },
        { key: 'remarks', label: 'Remarks', type: 'text', width: 3 },
        { key: 'actions', label: 'Action points', type: 'text', width: 1.6 },
        { key: 'followUp', label: 'Follow up', type: 'date', width: 0.8 },
    ],
    async run(f) {
        const p = await latest(f.ptm || undefined);
        if (!p) return { rows: [] };
        const meetings = await db.ptmMeeting.findMany({ where: { ptmId: p.id, status: 'attended' } });
        const [students, staff, remarks, enrol, sections] = await Promise.all([
            db.student.findMany({ where: { id: { in: meetings.map((m) => m.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.staff.findMany({ where: { id: { in: meetings.map((m) => m.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
            db.masterValue.findMany({ where: { master: 'ptm_remark' }, select: { id: true, name: true } }),
            db.enrolment.findMany({ where: { academicYearId: p.academicYearId, studentId: { in: meetings.map((m) => m.studentId) } }, select: { studentId: true, sectionId: true } }),
            sectionsOf(p.sectionIds),
        ]);
        const sec = (id: string) => {
            const e = enrol.find((x) => x.studentId === id);
            const s = sections.find((x) => x.id === e?.sectionId);
            return s ? sectionLabel(s) : '';
        };
        return {
            subtitle: `${p.title} · ${showDay(p.date)}`,
            rows: meetings
                .map((m) => ({ studentId: m.studentId, student: fullName(students.find((s) => s.id === m.studentId) ?? { firstName: '' }), section: sec(m.studentId), teacher: fullName(staff.find((s) => s.id === m.staffId) ?? { firstName: '' }), remarks: [...m.remarkIds.map((r) => remarks.find((x) => x.id === r)?.name).filter(Boolean), m.remarks].filter(Boolean).join('; '), actions: m.actions ?? '', followUp: m.followUpOn ? isoOf(m.followUpOn) : null }))
                .sort((a, b) => a.section.localeCompare(b.section) || a.student.localeCompare(b.student)),
        };
    },
});

defineReport({
    key: 'ptm_teachers',
    category: 'PTM',
    label: 'PTM by teacher',
    description: 'For a PTM: each teacher’s bookings, families met, didn’t come and walk-ins, and remarks written.',
    permissions: ['ptm.manage'],
    orientation: 'portrait',
    filters: [filterWithOptions()],
    columns: [
        { key: 'teacher', label: 'Teacher', type: 'text', width: 1.6 },
        { key: 'booked', label: 'Booked', type: 'number', width: 0.7, total: true },
        { key: 'met', label: 'Met', type: 'number', width: 0.6, total: true },
        { key: 'absent', label: 'Didn’t come', type: 'number', width: 0.8, total: true },
        { key: 'walkIns', label: 'Walk-ins', type: 'number', width: 0.7, total: true },
        { key: 'remarks', label: 'With remarks', type: 'number', width: 0.8, total: true },
    ],
    async run(f) {
        const p = await latest(f.ptm || undefined);
        if (!p) return { rows: [] };
        const meetings = await db.ptmMeeting.findMany({ where: { ptmId: p.id, status: { not: 'cancelled' } } });
        const staff = await db.staff.findMany({ where: { id: { in: [...new Set(meetings.map((m) => m.staffId))] } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
        return {
            subtitle: `${p.title} · ${showDay(p.date)}`,
            rows: staff
                .map((s) => {
                    const mine = meetings.filter((m) => m.staffId === s.id);
                    return { teacher: fullName(s), booked: mine.filter((m) => m.slot).length, met: mine.filter((m) => m.status === 'attended').length, absent: mine.filter((m) => m.status === 'absent').length, walkIns: mine.filter((m) => !m.slot).length, remarks: mine.filter((m) => m.status === 'attended' && (m.remarks || m.remarkIds.length)).length };
                })
                .sort((a, b) => a.teacher.localeCompare(b.teacher)),
        };
    },
});

// ─── Widgets ─────────────────────────────────────────────────────────────────

defineWidget({
    key: 'ptm_next',
    label: 'Next PTM',
    description: 'A parent’s next PTM: the date and their booked times (or a reminder to book).',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/my-ptm',
    permissions: ['ptm.mine'],
    cacheSeconds: 120,
    async load({ userId }) {
        const r = await myPtms(userId);
        const p = r.upcoming[0] as { title: string; date: string; bookingOpen: boolean; children: { name: string; teachers: { name: string; meeting: { slot: string | null } | null }[] }[] } | undefined;
        if (!p) return { hidden: true, items: [], empty: '' };
        const items = p.children.flatMap((c) => c.teachers.filter((t) => t.meeting?.slot).map((t) => ({ title: `${showTime(t.meeting!.slot!)} · ${t.name}`, sub: c.name, href: '/my-ptm' })));
        return { note: `${p.title} · ${showDay(p.date)}`, items, empty: p.bookingOpen ? 'No time booked yet: book now.' : 'No times booked.' };
    },
});

defineWidget({
    key: 'ptm_my_day',
    label: 'My PTM meetings',
    description: 'A teacher’s next PTM: how many families booked and the first times.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/ptm/meet',
    permissions: ['ptm.meet'],
    cacheSeconds: 120,
    async load({ userId }) {
        const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
        if (!staff) return { hidden: true, items: [], empty: '' };
        const r = await myMeetings(userId);
        if (!r.ptm || r.ptm.status !== 'published') return { hidden: true, items: [], empty: '' };
        const booked = r.families!.filter((f) => f.meeting?.slot);
        return { note: `${r.ptm.title} · ${showDay(r.ptm.date)} · ${booked.length} booked`, items: booked.slice(0, 6).map((f) => ({ title: `${showTime(f.meeting!.slot!)} · ${f.name}`, sub: f.section, href: '/ptm/meet' })), empty: 'No bookings yet.' };
    },
});
