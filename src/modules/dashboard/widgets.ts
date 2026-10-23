import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { staffName } from '../staff/staff.service';
import { fullName } from '../students/students.service';
import { sectionLabel, weekOf } from '../timetable/tt-setup.service';
import { publishedOf } from '../timetable/timetable.service';
import { ATTENDANCE, dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { dayOff } from '../attendance/calendar.service';
import { myAttendance, overview, summaries, viewableSections } from '../attendance/student-attendance.service';
import { myDay, myMonth, staffDay } from '../attendance/staff-attendance.service';
import { leaveRequests } from '../attendance/leave.service';
import { classSummary, collectionReport } from '../fees/fee-reports.service';
import { feeViewer } from '../fees/fee.reports';
import { myFees } from '../fees/my-fees.service';
import { modeNames } from '../fees/payment-modes';
import { enquirySummary } from '../admissions/enquiries.service';
import { enquiryViewer } from '../admissions/admissions.routes';
import { awayOn } from '../leave/staff-leave.service';
import { balancesOf, leaveYearOf } from '../leave/balances.service';
import { myNotices } from '../notices/notices.service';
import { upcoming } from '../notices/events.service';
import { defineDefaultLayout, defineWidget, ListData, registerWidgetCategory } from './dashboard.registry';

/** The widgets every school gets, and the layout each default role starts with. */

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const showDay = (iso: string, o: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });
const todayNote = () => `Today · ${showDay(todayIST())}`;

['Waiting for me', 'Today', 'Fees', 'Admissions', 'School', 'My day', 'My child', 'Notices & calendar'].forEach((c, i) => registerWidgetCategory(c, i));

// ─── Waiting for me ──────────────────────────────────────────────────────────

defineWidget({
    key: 'approvals',
    label: 'Waiting for me',
    description: 'Everything waiting for the person’s decision: staff leave, check-ins, corrections, student leave, notices, follow-ups due.',
    category: 'Waiting for me',
    type: 'list',
    size: 'md',
    permissions: ['leave.approve', 'leave.approve_all', 'attendance.staff', 'attendance.mark', 'attendance.mark_any', 'notice.publish', 'enquiry.view'],
    cacheSeconds: 60,
    async load({ userId, permissions: p }) {
        const items: ListData['items'] = [];
        const add = (n: number, title: string, href: string, tone: 'warn' | 'bad' = 'warn') => n > 0 && items.push({ title, badge: n, href, tone });
        if (p['leave.approve_all']) add(await db.staffLeave.count({ where: { status: 'pending', staff: { userId: { not: userId } } } }), 'Staff leave to approve', '/leave/approvals');
        else if (p['leave.approve']) add(await db.staffLeave.count({ where: { status: 'pending', stage: 1, staff: { reportsTo: { userId } } } }), 'Staff leave to approve', '/leave/approvals');
        if (p['attendance.staff']) {
            add(await db.staffAttendance.count({ where: { approval: 'pending' } }), 'Check-ins to approve', '/attendance/staff');
            add(await db.staffAttendanceRequest.count({ where: { status: 'pending' } }), 'Attendance corrections asked', '/attendance/staff');
        }
        if (p['attendance.mark'] || p['attendance.mark_any']) add((await leaveRequests({ status: 'pending' }, userId)).length, 'Student leave to approve', '/attendance/leave');
        if (p['notice.publish']) add(await db.notice.count({ where: { status: 'pending' } }), 'Notices to approve', '/notices/manage');
        if (p['enquiry.view']) {
            const year = await currentYear();
            const s = await enquirySummary(year?.id, await enquiryViewer(userId));
            add(s.overdue, 'Enquiry follow-ups overdue', '/admissions', 'bad');
            add(s.dueToday, 'Enquiry follow-ups due today', '/admissions');
        }
        return { items, empty: 'Nothing is waiting for you. 🎉' };
    },
});

// ─── Today ───────────────────────────────────────────────────────────────────

defineWidget({
    key: 'attendance_today',
    label: 'Students present today',
    description: 'Present out of those marked today, and how many sections have marked.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/attendance',
    permissions: ['attendance.view', 'attendance.mark_any'],
    cacheSeconds: 60,
    async load({ userId }) {
        const o = await overview({}, userId);
        if (o.dayOff) return { value: 'Holiday', caption: o.dayOff, tone: 'neutral', note: todayNote() };
        let present = 0;
        let marked = 0;
        for (const s of o.sections) {
            // The day's (or first period's / morning's) register of each section.
            const c = s.slots[0] as { marked: boolean; done?: number; present?: number; absent?: number; leave?: number } | undefined;
            if (c && (c.marked || (c.done ?? 0) > 0)) {
                present += c.present ?? 0;
                marked += (c.present ?? 0) + (c.absent ?? 0) + (c.leave ?? 0);
            }
        }
        const p = pct(present, marked);
        return {
            value: p == null ? '—' : `${p}%`,
            caption: marked ? `${present} of ${marked} students marked` : 'Nothing marked yet',
            tone: p == null ? 'neutral' : p >= 90 ? 'good' : p >= 75 ? 'warn' : 'bad',
            progress: { value: o.totals.marked, max: o.totals.sections, label: `${o.totals.marked} of ${o.totals.sections} sections marked` },
            note: todayNote(),
        };
    },
});

defineWidget({
    key: 'unmarked_sections',
    label: 'Not marked yet',
    description: 'Sections whose attendance hasn’t been taken today, with the class teacher.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/attendance',
    permissions: ['attendance.view', 'attendance.mark_any'],
    cacheSeconds: 60,
    async load({ userId }) {
        const o = await overview({}, userId);
        if (o.dayOff) return { items: [], empty: `No school today: ${o.dayOff}.`, note: todayNote() };
        const left = o.sections.filter((s) => !s.slots.every((x) => x.marked));
        return {
            items: left.slice(0, 8).map((s) => ({ title: s.label, sub: s.classTeacher ?? 'No class teacher', meta: `${s.students} students`, href: `/attendance/mark?section=${s.id}`, tone: 'warn' as const })),
            empty: 'Every section has marked attendance. ✓',
            more: left.length > 8 ? { label: `+${left.length - 8} more`, href: '/attendance' } : undefined,
            note: `${todayNote()} · ${left.length} of ${o.sections.length} left`,
        };
    },
});

defineWidget({
    key: 'low_attendance',
    label: 'Below the minimum attendance',
    description: 'Students under the school’s minimum attendance % this session, lowest first.',
    category: 'Today',
    type: 'list',
    size: 'md',
    href: '/attendance/students',
    permissions: ['attendance.view', 'attendance.mark_any'],
    cacheSeconds: 600,
    async load({ userId }) {
        const year = await currentYear();
        if (!year) return { items: [], empty: 'No current session.' };
        const scope = await viewableSections(userId);
        const enrol = await db.enrolment.findMany({
            where: { academicYearId: year.id, student: { status: 'active' }, ...(scope === 'all' ? {} : { sectionId: { in: scope } }) },
            select: { studentId: true, student: { select: { firstName: true, middleName: true, lastName: true } }, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } },
        });
        const sums = await summaries(enrol.map((e) => e.studentId), isoOf(year.startDate), todayIST());
        const { min } = await getSettings({ min: ATTENDANCE.minPercent });
        const low = enrol
            .map((e) => ({ e, s: sums.get(e.studentId)! }))
            .filter((x) => x.s.percent != null && x.s.days >= 5 && x.s.percent < min)
            .sort((a, b) => a.s.percent! - b.s.percent!);
        return {
            items: low.slice(0, 8).map(({ e, s }) => ({ title: fullName(e.student), sub: sectionLabel(e.section), meta: `${s.percent}%`, tone: s.percent! < min - 15 ? ('bad' as const) : ('warn' as const), href: `/attendance/students?student=${e.studentId}` })),
            empty: `Everyone is at or above ${min}%. ✓`,
            more: low.length > 8 ? { label: `+${low.length - 8} more`, href: '/attendance/students' } : undefined,
            note: `${low.length} below ${min}% this session`,
        };
    },
});

defineWidget({
    key: 'staff_today',
    label: 'Staff today',
    description: 'Staff checked in today, late, on leave and not in yet.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/attendance/staff',
    permissions: ['attendance.staff'],
    cacheSeconds: 60,
    async load() {
        const d = await staffDay({});
        if (d.dayOff) return { value: 'Day off', caption: d.dayOff, tone: 'neutral', note: todayNote() };
        const onLeave = d.staff.filter((s) => s.record?.source === 'leave').length;
        return {
            value: `${d.totals.in}/${d.totals.staff}`,
            caption: 'checked in',
            tone: d.totals.notIn > d.totals.staff * 0.2 ? 'warn' : 'good',
            progress: { value: d.totals.in, max: d.totals.staff },
            sub: [
                { label: 'Late', value: d.totals.late, tone: d.totals.late ? 'warn' : undefined },
                { label: 'On leave', value: onLeave },
                { label: 'Not in', value: Math.max(0, d.totals.notIn - onLeave), tone: d.totals.notIn - onLeave > 0 ? 'bad' : undefined },
            ],
            note: todayNote(),
        };
    },
});

defineWidget({
    key: 'staff_on_leave',
    label: 'Staff on leave today',
    description: 'Who is away today on approved leave, and who has asked.',
    category: 'Today',
    type: 'list',
    size: 'sm',
    href: '/leave',
    permissions: ['leave.view', 'leave.approve', 'leave.approve_all'],
    cacheSeconds: 120,
    async load() {
        const a = await awayOn();
        if (a.dayOff) return { items: [], empty: `Not a working day: ${a.dayOff}.`, note: todayNote() };
        return {
            items: a.away.map((x) => ({ title: x.name, sub: `${x.type}${x.half ? ` (${x.half} half)` : ''}`, meta: x.status === 'pending' ? 'asked' : undefined, tone: x.status === 'pending' ? ('warn' as const) : ('neutral' as const) })),
            empty: 'Everyone is in today.',
            note: todayNote(),
        };
    },
});

// ─── Fees ────────────────────────────────────────────────────────────────────

defineWidget({
    key: 'fee_today',
    label: 'Fees collected',
    description: 'Money received today, this month, and the number of receipts.',
    category: 'Fees',
    type: 'stat',
    size: 'sm',
    href: '/fees/reports',
    permissions: ['fee.reports', 'fee.collect'],
    cacheSeconds: 60,
    async load({ userId }) {
        const v = await feeViewer(userId);
        const t = todayIST();
        const [today, month] = await Promise.all([collectionReport({ from: t, to: t }, v), collectionReport({ from: `${t.slice(0, 7)}-01`, to: t }, v)]);
        return {
            value: rupees(today.total.amount),
            caption: `today · ${today.total.count} receipt${today.total.count === 1 ? '' : 's'}`,
            tone: 'good',
            sub: [
                { label: 'This month', value: rupees(month.total.amount) },
                { label: 'Receipts', value: month.total.count },
                ...(month.cancelled.count ? [{ label: 'Cancelled', value: month.cancelled.count, tone: 'warn' as const }] : []),
            ],
            note: todayNote(),
        };
    },
});

defineWidget({
    key: 'fee_dues',
    label: 'Fee dues',
    description: 'How much of the session’s fees is collected, what is overdue, and how many defaulters.',
    category: 'Fees',
    type: 'stat',
    size: 'sm',
    href: '/fees/dues',
    permissions: ['fee.reports', 'fee.view'],
    cacheSeconds: 300,
    async load({ userId }) {
        const s = await classSummary(undefined, await feeViewer(userId));
        const t = s.totals;
        return {
            value: rupees(t.overdue),
            caption: 'overdue',
            tone: t.overdue > 0 ? 'bad' : 'good',
            progress: { value: t.paid, max: t.net, label: `${pct(t.paid, t.net) ?? 0}% of ${rupees(t.net)} collected` },
            sub: [
                { label: 'Defaulters', value: t.defaulters, tone: t.defaulters ? 'bad' : undefined },
                { label: 'Still to come', value: rupees(t.balance) },
            ],
            note: 'This session',
        };
    },
});

defineWidget({
    key: 'fee_trend',
    label: 'Collection, last 30 days',
    description: 'Fees received each day over the last 30 days.',
    category: 'Fees',
    type: 'chart',
    size: 'lg',
    href: '/fees/reports',
    permissions: ['fee.reports'],
    cacheSeconds: 300,
    async load({ userId }) {
        const t = todayIST();
        const from = addDays(t, -29);
        const r = await collectionReport({ from, to: t }, await feeViewer(userId));
        const by = new Map(r.byDay.map((d) => [d.date, d.amount]));
        const points = [];
        for (let i = 0; i < 30; i++) {
            const d = addDays(from, i);
            points.push({ label: showDay(d, { day: 'numeric', month: 'short' }), value: by.get(d) ?? 0, hint: showDay(d) });
        }
        return { kind: 'bar', points, money: true, caption: `${rupees(r.total.amount)} in 30 days · ${r.total.count} receipts` };
    },
});

defineWidget({
    key: 'fee_by_mode',
    label: 'This month by payment mode',
    description: 'How this month’s fees were paid: cash, UPI, cheque, online…',
    category: 'Fees',
    type: 'donut',
    size: 'sm',
    href: '/fees/reports',
    permissions: ['fee.reports'],
    cacheSeconds: 300,
    async load({ userId }) {
        const t = todayIST();
        const [r, name] = await Promise.all([collectionReport({ from: `${t.slice(0, 7)}-01`, to: t }, await feeViewer(userId)), modeNames()]);
        return { slices: r.byMode.map((m) => ({ label: name(m.mode), value: m.amount })), money: true, centerLabel: rupees(r.total.amount) };
    },
});

defineWidget({
    key: 'fee_by_class',
    label: 'Collected by class',
    description: 'For each class, the share of the session’s fees collected so far.',
    category: 'Fees',
    type: 'chart',
    size: 'md',
    href: '/fees/reports',
    permissions: ['fee.reports'],
    cacheSeconds: 600,
    async load({ userId }) {
        const s = await classSummary(undefined, await feeViewer(userId));
        return { kind: 'bar', points: s.classes.map((c) => ({ label: c.name.replace(/^Class\s+/i, ''), value: pct(c.paid, c.net) ?? 0, hint: `${c.name}: ${rupees(c.paid)} of ${rupees(c.net)} · ${c.defaulters} defaulters` })), caption: '% of the session’s fees collected' };
    },
});

// ─── Admissions ──────────────────────────────────────────────────────────────

defineWidget({
    key: 'enquiries',
    label: 'Admission enquiries',
    description: 'Open enquiries this session, follow-ups due, and admissions done.',
    category: 'Admissions',
    type: 'stat',
    size: 'sm',
    href: '/admissions',
    permissions: ['enquiry.view', 'enquiry.reports'],
    cacheSeconds: 120,
    async load({ userId }) {
        const year = await currentYear();
        const s = await enquirySummary(year?.id, await enquiryViewer(userId));
        return {
            value: s.open,
            caption: 'open enquiries',
            tone: 'neutral',
            progress: { value: s.won, max: s.total, label: `${s.won} admitted of ${s.total} (${pct(s.won, s.total) ?? 0}%)` },
            sub: [
                { label: 'Due today', value: s.dueToday, tone: s.dueToday ? 'warn' : undefined },
                { label: 'Overdue', value: s.overdue, tone: s.overdue ? 'bad' : undefined },
                { label: 'Lost', value: s.lost },
            ],
            note: year ? `Session ${year.name}` : undefined,
        };
    },
});

defineWidget({
    key: 'admission_funnel',
    label: 'Enquiries by stage',
    description: 'How many enquiries are at each stage, from new to admitted.',
    category: 'Admissions',
    type: 'chart',
    size: 'md',
    href: '/admissions/reports',
    permissions: ['enquiry.view', 'enquiry.reports'],
    cacheSeconds: 300,
    async load({ userId }) {
        const year = await currentYear();
        const s = await enquirySummary(year?.id, await enquiryViewer(userId));
        return { kind: 'bar', points: s.stages.map((st) => ({ label: st.name, value: st.count })), caption: `${s.total} enquiries this session` };
    },
});

// ─── School ──────────────────────────────────────────────────────────────────

defineWidget({
    key: 'school_strength',
    label: 'School strength',
    description: 'Students on roll this session (boys / girls), sections and working staff.',
    category: 'School',
    type: 'stat',
    size: 'sm',
    href: '/students',
    permissions: ['student.view', 'staff.view'],
    cacheSeconds: 900,
    async load({ permissions: p }) {
        const year = await currentYear();
        const [students, staff, sections, genders] = await Promise.all([
            year ? db.enrolment.count({ where: { academicYearId: year.id, student: { status: 'active' } } }) : 0,
            p['staff.view'] === 'all' ? db.staff.count({ where: { status: 'working' } }) : null,
            year ? db.section.count({ where: { academicYearId: year.id, isActive: true } }) : 0,
            year ? db.student.groupBy({ by: ['genderId'], where: { status: 'active', enrolments: { some: { academicYearId: year.id } } }, _count: { _all: true } }) : [],
        ]);
        const names = new Map((await db.masterValue.findMany({ where: { id: { in: genders.map((g) => g.genderId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((g) => [g.id, g.name]));
        return {
            value: students,
            caption: 'students on roll',
            tone: 'neutral',
            sub: [
                ...genders
                    .filter((g) => g.genderId && names.get(g.genderId))
                    .sort((a, b) => b._count._all - a._count._all)
                    .slice(0, 2)
                    .map((g) => ({ label: names.get(g.genderId!)!, value: g._count._all })),
                { label: 'Sections', value: sections },
                ...(staff != null ? [{ label: 'Staff', value: staff }] : []),
            ],
            note: year ? `Session ${year.name}` : undefined,
        };
    },
});

// ─── My day (staff) ──────────────────────────────────────────────────────────

defineWidget({
    key: 'my_checkin',
    label: 'My check-in',
    description: 'Whether the person has checked in and out today, and their attendance this month.',
    category: 'My day',
    type: 'stat',
    size: 'sm',
    href: '/my-staff-attendance',
    permissions: ['attendance.checkin'],
    cacheSeconds: 30,
    async load({ userId }) {
        let d;
        try {
            d = await myDay(userId);
        } catch {
            return { hidden: true, value: '' };
        }
        const m = await myMonth(userId).catch(() => null);
        const p = m?.monthSummary.percent;
        const inAt = d.day?.checkIn;
        return {
            value: inAt ? inAt : d.reason && !d.canCheckIn ? '—' : 'Not yet',
            caption: inAt ? (d.day?.checkOut ? `in · out ${d.day.checkOut}` : `checked in${d.day?.late ? ' (late)' : ''}`) : (d.reason ?? 'not checked in today'),
            tone: inAt ? (d.day?.late ? 'warn' : 'good') : d.canCheckIn ? 'warn' : 'neutral',
            sub: p != null ? [{ label: 'This month', value: `${p}%`, tone: p < 90 ? 'warn' : undefined }] : [],
            action: d.canCheckIn ? { label: 'Check in', href: '/my-check-in' } : d.canCheckOut ? { label: 'Check out', href: '/my-check-in' } : undefined,
            note: todayNote(),
        };
    },
});

defineWidget({
    key: 'my_day',
    label: 'My periods today',
    description: 'Today’s periods from the timetable: a teacher’s own (with substitutions given to them), or a student’s class.',
    category: 'My day',
    type: 'list',
    size: 'md',
    href: '/my-timetable',
    permissions: ['timetable.mine'],
    cacheSeconds: 120,
    async load({ userId }) {
        const t = await publishedOf();
        if (!t) return { hidden: true, items: [], empty: '' };
        const today = todayIST();
        const off = await dayOff(today, 'staff');
        if (off) return { items: [], empty: `No school today: ${off}.`, note: todayNote() };
        const weekday = dayDate(today).getUTCDay() || 7;
        const day = (await weekOf(t.academicYearId)).find((d) => d.weekday === weekday);
        const time = (n: number) => day?.periods.find((p) => p.periodNo === n);
        const include = { subject: { select: { name: true } }, room: { select: { name: true } }, staff: { select: { firstName: true, middleName: true, lastName: true } }, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } as const;
        const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
        type Row = { periodNo: number; title: string; sub: string; tone?: 'warn' | 'good' | 'neutral' };
        const rows: Row[] = [];
        if (staff) {
            const [mine, subs] = await Promise.all([
                db.ttEntry.findMany({ where: { timetableId: t.id, staffId: staff.id, weekday }, include }),
                db.ttSubstitution.findMany({ where: { date: dayDate(today), OR: [{ substituteStaffId: staff.id }, { absentStaffId: staff.id }] }, select: { periodNo: true, sectionId: true, substituteStaffId: true, absentStaffId: true } }),
            ]);
            for (const e of mine) {
                const away = subs.find((s) => s.absentStaffId === staff.id && s.periodNo === e.periodNo && s.sectionId === e.sectionId);
                rows.push({ periodNo: e.periodNo, title: `${e.subject.name} · ${sectionLabel(e.section)}`, sub: away ? 'You are away: given to a substitute' : (e.room?.name ?? ''), tone: away ? 'neutral' : undefined });
            }
            const given = subs.filter((s) => s.substituteStaffId === staff.id);
            if (given.length) {
                const sections = new Map((await db.section.findMany({ where: { id: { in: given.map((g) => g.sectionId) } }, select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } })).map((s) => [s.id, sectionLabel(s)]));
                for (const g of given) rows.push({ periodNo: g.periodNo, title: `Substitution · ${sections.get(g.sectionId) ?? ''}`, sub: 'Arrangement period', tone: 'warn' });
            }
        } else {
            const year = await currentYear();
            const student = await db.student.findFirst({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { firstName: true, enrolments: { where: { academicYearId: year?.id }, select: { sectionId: true } } } });
            const sectionId = student?.enrolments[0]?.sectionId;
            if (!sectionId) return { hidden: true, items: [], empty: '' };
            for (const e of await db.ttEntry.findMany({ where: { timetableId: t.id, sectionId, weekday }, include })) rows.push({ periodNo: e.periodNo, title: e.subject.name, sub: e.staff ? staffName(e.staff) : '' });
        }
        rows.sort((a, b) => a.periodNo - b.periodNo);
        return {
            items: rows.map((r) => {
                const p = time(r.periodNo);
                return { title: r.title, sub: r.sub || undefined, meta: p ? `${p.label ?? `P${r.periodNo}`} · ${p.startTime}` : `P${r.periodNo}`, tone: r.tone };
            }),
            empty: 'No periods today.',
            note: `${todayNote()} · ${rows.length} period${rows.length === 1 ? '' : 's'}`,
        };
    },
});

defineWidget({
    key: 'my_class_attendance',
    label: 'My class today',
    description: 'For a class teacher: today’s attendance of their own section(s), or a reminder to mark it.',
    category: 'My day',
    type: 'list',
    size: 'sm',
    href: '/attendance/mark',
    permissions: ['attendance.mark'],
    cacheSeconds: 60,
    async load({ userId }) {
        const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
        if (!staff) return { hidden: true, items: [], empty: '' };
        const year = await currentYear();
        const own = year ? await db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id, isActive: true }, select: { id: true } }) : [];
        if (!own.length) return { hidden: true, items: [], empty: '' };
        const o = await overview({}, userId);
        if (o.dayOff) return { items: [], empty: `No school today: ${o.dayOff}.`, note: todayNote() };
        const ids = new Set(own.map((s) => s.id));
        return {
            items: o.sections
                .filter((s) => ids.has(s.id))
                .map((s) => {
                    const c = s.slots[0] as { marked: boolean; present?: number; absent?: number; leave?: number };
                    return c.marked
                        ? { title: s.label, sub: `${c.present ?? 0} present · ${c.absent ?? 0} absent${c.leave ? ` · ${c.leave} on leave` : ''}`, tone: (c.absent ?? 0) > 0 ? ('warn' as const) : ('good' as const), href: `/attendance/mark?section=${s.id}` }
                        : { title: s.label, sub: 'Not marked yet: mark it now', tone: 'bad' as const, href: `/attendance/mark?section=${s.id}` };
                }),
            empty: '',
            note: todayNote(),
        };
    },
});

defineWidget({
    key: 'my_leave',
    label: 'My leave balance',
    description: 'The person’s leave left of each type this year, and requests waiting.',
    category: 'My day',
    type: 'list',
    size: 'sm',
    href: '/my-leave',
    permissions: ['leave.apply'],
    cacheSeconds: 120,
    async load({ userId }) {
        const s = await db.staff.findFirst({ where: { userId }, select: { id: true, joiningDate: true, staffTypeId: true, employmentTypeId: true, genderId: true } });
        if (!s) return { hidden: true, items: [], empty: '' };
        const year = await leaveYearOf(todayIST());
        const b = ((await balancesOf([s], year)).get(s.id) ?? []).filter((x) => !x.unlimited && (x.balance > 0 || x.taken > 0 || x.pending > 0));
        return {
            items: b.map((x) => ({ title: x.name, sub: `${x.taken} taken${x.pending ? ` · ${x.pending} waiting` : ''}`, meta: `${x.available} left`, tone: x.available <= 0 ? ('bad' as const) : undefined })),
            empty: 'No leave balances yet.',
            more: { label: 'Ask for leave', href: '/my-leave' },
            note: `Leave year ${year.name}`,
        };
    },
});

// ─── My child (students and parents) ─────────────────────────────────────────

defineWidget({
    key: 'child_attendance',
    label: 'Attendance',
    description: 'For a student or parent: attendance % this month and this session.',
    category: 'My child',
    type: 'list',
    size: 'sm',
    href: '/my-attendance',
    permissions: ['attendance.mine'],
    cacheSeconds: 300,
    async load({ userId }) {
        const first = await myAttendance({}, userId);
        if (!first.children.length) return { hidden: true, items: [], empty: '' };
        type Month = { student: { name: string; section: string | null } | null; monthSummary?: { percent: number | null }; yearSummary?: { percent: number | null }; minPercent?: number };
        const all = (await Promise.all(first.children.map((c) => (c.id === first.student?.id ? first : myAttendance({ student: c.id }, userId))))) as Month[];
        const min = (first as Month).minPercent ?? 75;
        return {
            items: all.map((d) => {
                const y = d.yearSummary?.percent;
                const m = d.monthSummary?.percent;
                return { title: d.student?.name ?? '', sub: `This month ${m == null ? '—' : `${m}%`}${d.student?.section ? ` · ${d.student.section}` : ''}`, meta: y == null ? '—' : `${y}%`, tone: y == null ? undefined : y < min ? ('bad' as const) : ('good' as const), href: '/my-attendance' };
            }),
            empty: '',
            note: `Session so far · minimum ${min}%`,
        };
    },
});

defineWidget({
    key: 'child_fees',
    label: 'Fees',
    description: 'For a student or parent: what is due, what is overdue, the next due date, and paying online.',
    category: 'My child',
    type: 'stat',
    size: 'sm',
    href: '/my-fees',
    permissions: ['fee.pay_online'],
    cacheSeconds: 120,
    async load({ userId }) {
        const f = await myFees(userId);
        if (!f.children.length) return { hidden: true, value: '' };
        const balance = f.children.reduce((a, c) => a + c.dues.totals.balance, 0);
        const overdue = f.children.reduce((a, c) => a + c.dues.totals.overdue, 0);
        const next = f.children.flatMap((c) => c.dues.instalments.filter((i) => i.balance > 0)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
        return {
            value: rupees(balance),
            caption: balance > 0 ? 'still to pay this session' : 'all paid ✓',
            tone: overdue > 0 ? 'bad' : balance > 0 ? 'warn' : 'good',
            sub: [...(overdue > 0 ? [{ label: 'Overdue', value: rupees(overdue), tone: 'bad' as const }] : []), ...(next ? [{ label: `${next.name} due`, value: showDay(next.dueDate, { day: 'numeric', month: 'short' }) }] : [])],
            action: balance > 0 && f.online.enabled ? { label: 'Pay now', href: '/my-fees' } : { label: 'See fees', href: '/my-fees' },
            note: f.academicYear ? `Session ${f.academicYear.name}` : undefined,
        };
    },
});

// ─── Notices & calendar (everyone) ───────────────────────────────────────────

defineWidget({
    key: 'notices_latest',
    label: 'Latest notices',
    description: 'The newest notices for the person, unread ones marked.',
    category: 'Notices & calendar',
    type: 'list',
    size: 'md',
    href: '/notices',
    permissions: [],
    cacheSeconds: 60,
    async load({ userId }) {
        const list = await myNotices({ archive: '0' }, userId);
        const unread = list.filter((n) => !n.read).length;
        return {
            items: list.slice(0, 5).map((n) => ({ title: n.title, sub: [n.category, n.publishAt ? new Date(n.publishAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : null].filter(Boolean).join(' · '), badge: n.read ? undefined : 'new', tone: n.important ? ('bad' as const) : undefined, href: '/notices' })),
            empty: 'No notices for you right now.',
            more: list.length > 5 ? { label: `All ${list.length} notices`, href: '/notices' } : undefined,
            note: unread ? `${unread} unread` : undefined,
        };
    },
});

defineWidget({
    key: 'upcoming_events',
    label: 'Coming up',
    description: 'Events and holidays of the next 30 days on the school calendar.',
    category: 'Notices & calendar',
    type: 'list',
    size: 'md',
    href: '/events',
    permissions: [],
    cacheSeconds: 300,
    async load({ userId }) {
        const list = await upcoming(userId);
        return {
            items: list.slice(0, 6).map((e) => ({
                title: e.title,
                sub: [e.type, e.startTime ? `${e.startTime}${e.endTime ? `–${e.endTime}` : ''}` : null, e.venue].filter(Boolean).join(' · '),
                meta: e.from === e.to ? showDay(e.from) : `${showDay(e.from, { day: 'numeric', month: 'short' })}–${showDay(e.to, { day: 'numeric', month: 'short' })}`,
                tone: e.holidayFor !== 'none' ? ('warn' as const) : undefined,
                href: '/events',
            })),
            empty: 'Nothing in the next 30 days.',
        };
    },
});

// ─── The layouts each role starts with ───────────────────────────────────────

const LEADERSHIP = ['approvals', 'attendance_today', 'staff_today', 'fee_today', 'fee_dues', 'exam_entry_progress', 'exam_last_result', 'unmarked_sections', 'staff_on_leave', 'fee_trend', 'enquiries', 'school_strength', 'admission_funnel', 'fee_by_class', 'low_attendance', 'notices_latest', 'upcoming_events'];
defineDefaultLayout('school-admin', LEADERSHIP);
defineDefaultLayout('super-admin', LEADERSHIP);
defineDefaultLayout('principal', ['approvals', 'attendance_today', 'staff_today', 'exam_last_result', 'exam_entry_progress', 'fee_dues', 'school_strength', 'unmarked_sections', 'staff_on_leave', 'fee_trend', 'low_attendance', 'enquiries', 'admission_funnel', 'notices_latest', 'upcoming_events', 'my_checkin']);
defineDefaultLayout('office-staff', ['approvals', 'my_checkin', 'attendance_today', 'exam_entry_progress', 'staff_today', 'unmarked_sections', 'staff_on_leave', 'fee_today', 'enquiries', 'notices_latest', 'upcoming_events', 'my_leave']);
defineDefaultLayout('accountant', ['fee_today', 'fee_dues', 'fee_by_mode', 'my_checkin', 'fee_trend', 'fee_by_class', 'approvals', 'notices_latest', 'my_leave', 'upcoming_events']);
defineDefaultLayout('teacher', ['my_checkin', 'my_class_attendance', 'my_day', 'homework_to_check', 'tests_to_mark', 'approvals', 'my_leave', 'notices_latest', 'upcoming_events']);
defineDefaultLayout('class-teacher', ['my_checkin', 'my_class_attendance', 'my_day', 'homework_to_check', 'tests_to_mark', 'approvals', 'my_leave', 'low_attendance', 'notices_latest', 'upcoming_events']);
defineDefaultLayout('student', ['homework_due', 'my_tests', 'my_library_books', 'child_attendance', 'child_fees', 'child_results', 'my_day', 'notices_latest', 'upcoming_events']);
defineDefaultLayout('guardian', ['homework_due', 'my_tests', 'my_library_books', 'child_attendance', 'child_fees', 'child_results', 'my_day', 'notices_latest', 'upcoming_events']);
