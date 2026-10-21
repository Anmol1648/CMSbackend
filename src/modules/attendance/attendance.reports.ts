import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { fullName } from '../students/students.service';
import { defineReport, ReportColumn } from '../reports/reports.registry';
import { defineDataSource } from '../reports/datasources.registry';
import { ATTENDANCE, dayDate, isoOf, todayIST } from './attendance.settings';
import { daysOff, schoolDays } from './calendar.service';
import { statuses, summaries, viewableSections } from './student-attendance.service';

/** Attendance reports (Report Center) and data sources (Report Builder). */

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const label = (s: { name: string; schoolClass: { name: string; shortName: string | null } }) => `${s.schoolClass.shortName ?? s.schoolClass.name}-${s.name}`;
const monthOf = (iso: string) => {
    const first = `${iso.slice(0, 7)}-01`;
    const last = isoOf(new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)));
    return { first, last, name: new Date(`${first}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
};

/** Sections of a session the person may see, optionally one class / one section. */
const sectionsFor = async (userId: string, yearId: string | undefined, classId?: string, sectionId?: string) => {
    const scope = await viewableSections(userId);
    const year = yearId ? await db.academicYear.findUnique({ where: { id: yearId } }) : await db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) throw badRequest('No academic year');
    const sections = await db.section.findMany({
        where: { academicYearId: year.id, isActive: true, ...(classId ? { classId } : {}), ...(sectionId ? { id: sectionId } : {}), ...(scope === 'all' ? {} : { id: { in: scope } }) },
        select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    return { year, sections };
};

const studentsOf = async (yearId: string, sectionIds: string[]) =>
    (
        await db.enrolment.findMany({
            where: { academicYearId: yearId, sectionId: { in: sectionIds } },
            select: {
                sectionId: true,
                rollNumber: true,
                student: { select: { id: true, admissionNo: true, firstName: true, middleName: true, lastName: true, status: true, family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, mobile: true } } } } } },
            },
        })
    ).sort((a, b) => (a.rollNumber ?? 9999) - (b.rollNumber ?? 9999) || a.student.firstName.localeCompare(b.student.firstName));

// ─── Absentees of a day ──────────────────────────────────────────────────────

defineReport({
    key: 'attendance_absentees',
    category: 'Attendance',
    label: 'Absentees of the day',
    description: 'Students marked absent, late, half day or on leave on a day, section by section, with the parent’s number to call.',
    permissions: ['attendance.view', 'attendance.mark_any'],
    orientation: 'portrait',
    filters: [
        { key: 'date', label: 'Date', type: 'date', required: true, default: 'today' },
        { key: 'class', label: 'Class', type: 'class' },
        {
            key: 'show',
            label: 'Show',
            type: 'select',
            default: 'absent',
            options: [
                { value: 'absent', label: 'Absent only' },
                { value: 'notPresent', label: 'Everyone not fully present (absent, late, half day, leave)' },
            ],
        },
    ],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.5 },
        { key: 'student', label: 'Student', type: 'text', width: 2 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'status', label: 'Status', type: 'text', width: 1 },
        { key: 'note', label: 'Note', type: 'text', width: 1.3 },
        { key: 'parent', label: 'Parent', type: 'text', width: 1.4 },
        { key: 'mobile', label: 'Mobile', type: 'text', width: 1 },
    ],
    async run(f, ctx) {
        const { year, sections } = await sectionsFor(ctx.userId, undefined, f.class);
        const list = await statuses();
        const byId = new Map(list.map((s) => [s.id, s]));
        const marks = await db.attendanceMark.findMany({
            where: { sheet: { date: dayDate(f.date), sectionId: { in: sections.map((s) => s.id) } } },
            select: { statusId: true, note: true, studentId: true, sheet: { select: { sectionId: true, slot: true } } },
        });
        const students = new Map((await studentsOf(year.id, sections.map((s) => s.id))).map((e) => [e.student.id, e]));
        const order = new Map(sections.map((s, i) => [s.id, i]));
        const rows = marks
            .filter((m) => {
                const st = byId.get(m.statusId);
                return st && (f.show === 'notPresent' ? st.present < 1 || st.code === 'LT' : st.present === 0 && !st.excused);
            })
            .map((m) => {
                const e = students.get(m.studentId);
                const sec = sections.find((s) => s.id === m.sheet.sectionId)!;
                const st = byId.get(m.statusId)!;
                return {
                    order: order.get(sec.id) ?? 0,
                    roll: e?.rollNumber ?? null,
                    student: e ? fullName(e.student) : '—',
                    admissionNo: e?.student.admissionNo ?? '',
                    status: m.sheet.slot === 'day' ? st.name : `${st.name} (${m.sheet.slot === 'am' ? 'morning' : 'afternoon'})`,
                    note: m.note ?? '',
                    parent: e?.student.family?.guardians[0]?.name ?? '',
                    mobile: e?.student.family?.guardians[0]?.mobile ?? '',
                    groupKey: String(order.get(sec.id) ?? 0).padStart(4, '0'),
                    groupLabel: label(sec),
                };
            })
            .sort((a, b) => a.order - b.order || (a.roll ?? 9999) - (b.roll ?? 9999))
            .map(({ order: _o, ...r }) => r);
        return { rows, subtitle: `${day(f.date)}${f.show === 'notPresent' ? ' · not fully present' : ' · absent'}`, groupedBy: 'Section' };
    },
});

// ─── Monthly register (the classic grid) ─────────────────────────────────────

const DAY_COLUMNS: ReportColumn[] = Array.from({ length: 31 }, (_, i) => ({ key: `d${i + 1}`, label: String(i + 1), type: 'text', width: 0.28 }));

defineReport({
    key: 'attendance_monthly_register',
    category: 'Attendance',
    label: 'Monthly attendance register',
    description: 'The register of a section for a month: every student × every day (P, A, L…), with days present, absent and the %.',
    permissions: ['attendance.view', 'attendance.mark_any'],
    orientation: 'landscape',
    filters: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'class', label: 'Class', type: 'class', required: true },
        { key: 'section', label: 'Section', type: 'section', required: true },
        { key: 'month', label: 'Month (any day of it)', type: 'date', required: true, default: 'monthStart' },
    ],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.35 },
        { key: 'student', label: 'Student', type: 'text', width: 1.6 },
        ...DAY_COLUMNS,
        { key: 'present', label: 'Pres.', type: 'number', width: 0.45 },
        { key: 'absent', label: 'Abs.', type: 'number', width: 0.45 },
        { key: 'percent', label: '%', type: 'number', width: 0.45 },
    ],
    async run(f, ctx) {
        const { year, sections } = await sectionsFor(ctx.userId, f.year, f.class, f.section);
        if (!sections.length) throw badRequest('You can’t see this section’s attendance', [{ field: 'section', message: 'is not one of yours' }]);
        const sec = sections[0];
        const m = monthOf(f.month);
        const to = m.last < todayIST() ? m.last : todayIST();
        const [list, off, enrolled] = await Promise.all([statuses(), daysOff(m.first, m.last, 'students'), studentsOf(year.id, [sec.id])]);
        const byId = new Map(list.map((s) => [s.id, s]));
        const marks = await db.attendanceMark.findMany({ where: { sheet: { sectionId: sec.id, date: { gte: dayDate(m.first), lte: dayDate(m.last) } } }, select: { studentId: true, statusId: true, sheet: { select: { date: true, slot: true } } } });
        const sums = await summaries(enrolled.map((e) => e.student.id), m.first, to);
        const lastDay = Number(m.last.slice(8, 10));
        const rows = enrolled.map((e) => {
            const row: Record<string, unknown> = { roll: e.rollNumber, student: fullName(e.student) };
            for (let d = 1; d <= 31; d++) {
                if (d > lastDay) continue;
                const iso = `${m.first.slice(0, 8)}${String(d).padStart(2, '0')}`;
                const mine = marks.filter((x) => x.studentId === e.student.id && isoOf(x.sheet.date) === iso).sort((a, b) => a.sheet.slot.localeCompare(b.sheet.slot));
                row[`d${d}`] = mine.length ? mine.map((x) => byId.get(x.statusId)?.code ?? '?').join('/') : off.has(iso) ? (off.get(iso)!.startsWith('Weekly off') || off.get(iso)!.endsWith('Saturday off') ? '–' : 'H') : '';
            }
            const s = sums.get(e.student.id)!;
            row.present = s.present;
            row.absent = s.absent;
            row.percent = s.percent;
            return row;
        });
        return { rows, subtitle: `${label(sec)} · ${m.name} · ${year.name}   (– weekly off, H holiday)` };
    },
});

// ─── Attendance % of students ────────────────────────────────────────────────

defineReport({
    key: 'attendance_percentage',
    category: 'Attendance',
    label: 'Attendance % of students',
    description: 'Each student’s days present, absent and on leave, and the % for a period, section by section; optionally only those below the minimum.',
    permissions: ['attendance.view', 'attendance.mark_any'],
    orientation: 'portrait',
    filters: [
        { key: 'year', label: 'Session', type: 'year', required: true, default: 'current' },
        { key: 'class', label: 'Class', type: 'class' },
        { key: 'section', label: 'Section', type: 'section' },
        { key: 'from', label: 'From', type: 'date', required: true, default: 'sessionStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
        {
            key: 'show',
            label: 'Show',
            type: 'select',
            default: 'all',
            options: [
                { value: 'all', label: 'Every student' },
                { value: 'below', label: 'Only those below the minimum %' },
            ],
        },
    ],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.5 },
        { key: 'student', label: 'Student', type: 'text', width: 2 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'days', label: 'Days', type: 'number', width: 0.6 },
        { key: 'present', label: 'Present', type: 'number', width: 0.7 },
        { key: 'absent', label: 'Absent', type: 'number', width: 0.7 },
        { key: 'excused', label: 'Leave', type: 'number', width: 0.6 },
        { key: 'percent', label: '%', type: 'number', width: 0.6 },
        { key: 'parent', label: 'Parent', type: 'text', width: 1.3 },
        { key: 'mobile', label: 'Mobile', type: 'text', width: 1 },
    ],
    async run(f, ctx) {
        if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const { year, sections } = await sectionsFor(ctx.userId, f.year, f.class, f.section);
        const enrolled = (await studentsOf(year.id, sections.map((s) => s.id))).filter((e) => e.student.status === 'active');
        const sums = await summaries(enrolled.map((e) => e.student.id), f.from, f.to);
        const { minPercent } = await getSettings({ minPercent: ATTENDANCE.minPercent });
        const order = new Map(sections.map((s, i) => [s.id, i]));
        const rows = enrolled
            .map((e) => {
                const s = sums.get(e.student.id)!;
                const sec = sections.find((x) => x.id === e.sectionId)!;
                return {
                    order: order.get(sec.id) ?? 0,
                    roll: e.rollNumber,
                    student: fullName(e.student),
                    admissionNo: e.student.admissionNo,
                    days: s.days,
                    present: s.present,
                    absent: s.absent,
                    excused: s.excused,
                    percent: s.percent,
                    parent: e.student.family?.guardians[0]?.name ?? '',
                    mobile: e.student.family?.guardians[0]?.mobile ?? '',
                    groupKey: String(order.get(sec.id) ?? 0).padStart(4, '0'),
                    groupLabel: label(sec),
                };
            })
            .filter((r) => f.show !== 'below' || (r.percent !== null && r.percent < minPercent))
            .sort((a, b) => a.order - b.order || (a.roll ?? 9999) - (b.roll ?? 9999))
            .map(({ order: _o, ...r }) => r);
        return { rows, subtitle: `${year.name} · ${day(f.from)} – ${day(f.to)}${f.show === 'below' ? ` · below ${minPercent}%` : ''}`, groupedBy: 'Section' };
    },
});

// ─── Section summary ─────────────────────────────────────────────────────────

defineReport({
    key: 'attendance_section_summary',
    category: 'Attendance',
    label: 'Attendance by section',
    description: 'For each section in a period: school days, registers marked (and missing), and the average attendance %.',
    permissions: ['attendance.view', 'attendance.mark_any'],
    orientation: 'portrait',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'section', label: 'Section', type: 'text', width: 1.2 },
        { key: 'students', label: 'Students', type: 'number', width: 0.8, total: true },
        { key: 'schoolDays', label: 'School days', type: 'number', width: 0.8 },
        { key: 'marked', label: 'Days marked', type: 'number', width: 0.8 },
        { key: 'missing', label: 'Not marked', type: 'number', width: 0.8, total: true },
        { key: 'percent', label: 'Average %', type: 'number', width: 0.8 },
    ],
    async run(f, ctx) {
        if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const { year, sections } = await sectionsFor(ctx.userId, undefined);
        const to = f.to < todayIST() ? f.to : todayIST();
        const days = await schoolDays(f.from, to, 'students');
        const enrolled = (await studentsOf(year.id, sections.map((s) => s.id))).filter((e) => e.student.status === 'active');
        const sums = await summaries(enrolled.map((e) => e.student.id), f.from, to);
        const sheets = await db.attendanceSheet.groupBy({ by: ['sectionId', 'date'], where: { sectionId: { in: sections.map((s) => s.id) }, date: { gte: dayDate(f.from), lte: dayDate(to) } } });
        const rows = sections.map((s) => {
            const mine = enrolled.filter((e) => e.sectionId === s.id);
            const pcts = mine.map((e) => sums.get(e.student.id)!.percent).filter((p): p is number => p !== null);
            const marked = sheets.filter((x) => x.sectionId === s.id).length;
            return { section: label(s), students: mine.length, schoolDays: days.length, marked, missing: Math.max(0, days.length - marked), percent: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null };
        });
        return { rows, subtitle: `${day(f.from)} – ${day(to)} · ${days.length} school days` };
    },
});

// ─── Staff attendance of a month ─────────────────────────────────────────────

defineReport({
    key: 'staff_attendance_monthly',
    category: 'Attendance',
    label: 'Staff attendance of a month',
    description: 'Each staff member’s working days, days present, late arrivals, half days, leave and days absent in a month.',
    permissions: ['attendance.staff'],
    orientation: 'portrait',
    filters: [{ key: 'month', label: 'Month (any day of it)', type: 'date', required: true, default: 'monthStart' }],
    columns: [
        { key: 'employeeCode', label: 'Code', type: 'text', width: 0.8 },
        { key: 'name', label: 'Name', type: 'text', width: 1.8 },
        { key: 'designation', label: 'Designation', type: 'text', width: 1.3 },
        { key: 'workingDays', label: 'Working days', type: 'number', width: 0.7 },
        { key: 'present', label: 'Present', type: 'number', width: 0.7, total: true },
        { key: 'late', label: 'Late', type: 'number', width: 0.6, total: true },
        { key: 'halfDay', label: 'Half days', type: 'number', width: 0.6, total: true },
        { key: 'leave', label: 'Leave', type: 'number', width: 0.6, total: true },
        { key: 'absent', label: 'Absent', type: 'number', width: 0.6, total: true },
    ],
    async run(f) {
        const m = monthOf(f.month);
        const to = m.last < todayIST() ? m.last : todayIST();
        const days = await schoolDays(m.first, to, 'staff');
        const [staff, rows, list] = await Promise.all([
            db.staff.findMany({ where: { joiningDate: { lte: dayDate(to) }, OR: [{ status: 'working' }, { statusDate: { gte: dayDate(m.first) } }] }, select: { id: true, employeeCode: true, firstName: true, middleName: true, lastName: true, joiningDate: true, designation: { select: { name: true } } }, orderBy: { firstName: 'asc' } }),
            db.staffAttendance.findMany({ where: { date: { gte: dayDate(m.first), lte: dayDate(to) } }, select: { staffId: true, date: true, statusId: true, late: true, checkIn: true } }),
            statuses(),
        ]);
        const byId = new Map(list.map((s) => [s.id, s]));
        const out = staff.map((s) => {
            const mine = rows.filter((r) => r.staffId === s.id && days.includes(isoOf(r.date)));
            const working = days.filter((d) => d >= isoOf(s.joiningDate)).length;
            const st = (r: (typeof mine)[number]) => (r.statusId ? byId.get(r.statusId) : undefined);
            const leave = mine.filter((r) => st(r)?.excused).length;
            const presentRows = mine.filter((r) => (st(r) ? st(r)!.present > 0 : !!r.checkIn));
            return {
                employeeCode: s.employeeCode,
                name: fullName(s),
                designation: s.designation?.name ?? '',
                workingDays: working,
                present: presentRows.length,
                late: mine.filter((r) => r.late).length,
                halfDay: mine.filter((r) => st(r)?.code === 'HD').length,
                leave,
                absent: Math.max(0, working - presentRows.length - leave),
            };
        });
        return { rows: out, subtitle: `${m.name} · ${days.length} working days${to < m.last ? ' so far' : ''}` };
    },
});

// ─── Report Builder data ─────────────────────────────────────────────────────

defineDataSource({
    key: 'student_attendance',
    label: 'Student attendance (day by day)',
    description: 'One row per student per register in a period: the date, section, status and what it counts as.',
    category: 'Attendance',
    permissions: ['attendance.view', 'attendance.mark_any'],
    params: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'monthStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    fields: [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'part', label: 'Part of the day', type: 'text' },
        { key: 'section', label: 'Class and section', type: 'text' },
        { key: 'className', label: 'Class', type: 'text' },
        { key: 'roll', label: 'Roll no.', type: 'number' },
        { key: 'student', label: 'Student', type: 'text' },
        { key: 'admissionNo', label: 'Admission no.', type: 'text' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'statusCode', label: 'Status code', type: 'text' },
        { key: 'present', label: 'Counts as present', type: 'number' },
        { key: 'absent', label: 'Absent', type: 'boolean' },
        { key: 'onLeave', label: 'On leave', type: 'boolean' },
        { key: 'note', label: 'Note', type: 'text' },
        { key: 'parent', label: 'Parent', type: 'text', group: 'Family' },
        { key: 'mobile', label: 'Parent’s mobile', type: 'text', group: 'Family' },
    ],
    async load(p, ctx) {
        if (p.from > p.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const scope = await viewableSections(ctx.userId);
        const list = await statuses();
        const byId = new Map(list.map((s) => [s.id, s]));
        const marks = await db.attendanceMark.findMany({
            where: { sheet: { date: { gte: dayDate(p.from), lte: dayDate(p.to) }, ...(scope === 'all' ? {} : { sectionId: { in: scope } }) } },
            select: {
                note: true,
                statusId: true,
                sheet: { select: { date: true, slot: true, section: { select: { id: true, name: true, academicYearId: true, schoolClass: { select: { name: true, shortName: true } } } } } },
                student: { select: { id: true, admissionNo: true, firstName: true, middleName: true, lastName: true, family: { select: { guardians: { where: { isPrimary: true }, select: { name: true, mobile: true } } } } } },
            },
            orderBy: [{ sheet: { date: 'asc' } }],
        });
        const rolls = new Map(
            (await db.enrolment.findMany({ where: { studentId: { in: [...new Set(marks.map((m) => m.student.id))] }, sectionId: { in: [...new Set(marks.map((m) => m.sheet.section.id))] } }, select: { studentId: true, sectionId: true, rollNumber: true } })).map((e) => [`${e.studentId}|${e.sectionId}`, e.rollNumber])
        );
        return marks.map((m) => {
            const st = byId.get(m.statusId);
            return {
                date: isoOf(m.sheet.date),
                part: m.sheet.slot === 'day' ? 'Whole day' : m.sheet.slot === 'am' ? 'Morning' : 'Afternoon',
                section: label(m.sheet.section),
                className: m.sheet.section.schoolClass.name,
                roll: rolls.get(`${m.student.id}|${m.sheet.section.id}`) ?? null,
                student: fullName(m.student),
                admissionNo: m.student.admissionNo,
                status: st?.name ?? null,
                statusCode: st?.code ?? null,
                present: st?.present ?? 0,
                absent: !!st && st.present === 0 && !st.excused,
                onLeave: !!st?.excused,
                note: m.note,
                parent: m.student.family?.guardians[0]?.name ?? null,
                mobile: m.student.family?.guardians[0]?.mobile ?? null,
            };
        });
    },
});
