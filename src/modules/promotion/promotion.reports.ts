import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { defineReport } from '../reports/reports.registry';
import { dayDate, isoOf } from '../attendance/attendance.settings';

/** Promotion and TC reports (Report Center → Students). */

const OUTCOME: Record<string, string> = { promoted: 'Promoted', detained: 'Kept back', passed_out: 'Passed out', leaving: 'Leaving (TC)' };
const showDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const check = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
};

defineReport({
    key: 'promotion_list',
    category: 'Students',
    label: 'Promotion list',
    description: 'What happened to each student at the end of a session: promoted (to which section), kept back, passed out or leaving.',
    permissions: ['promotion.manage'],
    orientation: 'portrait',
    filters: [{ key: 'year', label: 'Session promoted from', type: 'year', required: true, default: 'current' }],
    columns: [
        { key: 'roll', label: 'Roll', type: 'number', width: 0.5 },
        { key: 'student', label: 'Student', type: 'text', width: 2 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 1 },
        { key: 'outcome', label: 'Result', type: 'text', width: 1 },
        { key: 'to', label: 'New section', type: 'text', width: 1 },
        { key: 'carried', label: 'Dues carried', type: 'money', width: 1, total: true },
    ],
    async run(f) {
        const rows = await db.studentPromotion.findMany({ where: { fromYearId: f.year }, include: { student: { select: { firstName: true, middleName: true, lastName: true, admissionNo: true } } } });
        const sectionIds = [...new Set(rows.flatMap((r) => [r.fromSectionId, r.toSectionId]).filter((x): x is string => !!x))];
        const sections = new Map((await db.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } })).map((s) => [s.id, s]));
        const rolls = new Map((await db.enrolment.findMany({ where: { academicYearId: f.year, studentId: { in: rows.map((r) => r.studentId) } }, select: { studentId: true, rollNumber: true } })).map((e) => [e.studentId, e.rollNumber]));
        const year = await db.academicYear.findUnique({ where: { id: f.year }, select: { name: true } });
        return {
            rows: rows
                .map((r) => {
                    const from = sections.get(r.fromSectionId);
                    const to = r.toSectionId ? sections.get(r.toSectionId) : null;
                    return {
                        groupKey: from ? `${String(from.schoolClass.sortOrder).padStart(4, '0')}${String(from.sortOrder).padStart(3, '0')}` : '9999',
                        groupLabel: from ? sectionLabel(from) : '—',
                        roll: rolls.get(r.studentId) ?? null,
                        student: fullName(r.student),
                        admissionNo: r.student.admissionNo,
                        outcome: OUTCOME[r.outcome] ?? r.outcome,
                        to: to ? sectionLabel(to) : '',
                        carried: r.carriedAmount || null,
                    };
                })
                .sort((a, b) => a.groupKey.localeCompare(b.groupKey) || (a.roll ?? 999) - (b.roll ?? 999)),
            subtitle: year ? `From ${year.name}` : undefined,
            groupedBy: 'Section',
        };
    },
});

defineReport({
    key: 'tc_register',
    category: 'Students',
    label: 'TC register',
    description: 'Transfer certificates issued in a period: TC number, student, class, leaving date and reason.',
    permissions: ['tc.manage'],
    orientation: 'landscape',
    filters: [
        { key: 'from', label: 'Issued from', type: 'date', required: true, default: 'sessionStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'tcNo', label: 'TC no.', type: 'text', width: 1.1 },
        { key: 'issued', label: 'Issued on', type: 'date', width: 0.9 },
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'lastClass', label: 'Class', type: 'text', width: 0.9 },
        { key: 'leaving', label: 'Left on', type: 'date', width: 0.9 },
        { key: 'reason', label: 'Reason', type: 'text', width: 1.4 },
        { key: 'conduct', label: 'Conduct', type: 'text', width: 0.7 },
    ],
    async run(f) {
        check(f);
        const rows = await db.transferCertificate.findMany({
            where: { status: 'issued', issuedAt: { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) } },
            include: { student: { select: { firstName: true, middleName: true, lastName: true, admissionNo: true } } },
            orderBy: { issuedAt: 'asc' },
        });
        const reasons = new Map((await db.masterValue.findMany({ where: { master: 'leaving_reason' }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
        return {
            rows: rows.map((r) => ({ tcNo: r.tcNo, issued: r.issuedAt ? r.issuedAt.toISOString().slice(0, 10) : null, student: fullName(r.student), admissionNo: r.student.admissionNo, lastClass: r.lastClass, leaving: isoOf(r.leavingDate), reason: r.reasonId ? (reasons.get(r.reasonId) ?? null) : null, conduct: r.conduct })),
            subtitle: `${showDay(f.from)} – ${showDay(f.to)}`,
        };
    },
});

defineReport({
    key: 'students_left',
    category: 'Students',
    label: 'Students who left',
    description: 'Students who left, passed out or were struck off in a period, with the reason and their last class.',
    permissions: ['student.view', 'tc.manage'],
    orientation: 'portrait',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'sessionStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.9 },
        { key: 'student', label: 'Student', type: 'text', width: 1.8 },
        { key: 'admissionNo', label: 'Adm. no.', type: 'text', width: 0.9 },
        { key: 'status', label: 'Status', type: 'text', width: 0.9 },
        { key: 'lastClass', label: 'Last class', type: 'text', width: 0.9 },
        { key: 'reason', label: 'Reason', type: 'text', width: 1.4 },
        { key: 'tcNo', label: 'TC no.', type: 'text', width: 1 },
    ],
    async run(f) {
        check(f);
        const rows = await db.student.findMany({
            where: { status: { in: ['left', 'passed_out', 'struck_off'] }, statusDate: { gte: dayDate(f.from), lte: dayDate(f.to) } },
            select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, status: true, statusDate: true, tcNumber: true, leavingReason: { select: { name: true } }, enrolments: { orderBy: { academicYear: { startDate: 'desc' } }, take: 1, select: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } } },
            orderBy: { statusDate: 'asc' },
        });
        const STATUS: Record<string, string> = { left: 'Left (TC)', passed_out: 'Passed out', struck_off: 'Struck off' };
        return {
            rows: rows.map((s) => ({ date: s.statusDate ? isoOf(s.statusDate) : null, student: fullName(s), admissionNo: s.admissionNo, status: STATUS[s.status] ?? s.status, lastClass: s.enrolments[0] ? sectionLabel(s.enrolments[0].section) : null, reason: s.leavingReason?.name ?? null, tcNo: s.tcNumber })),
            subtitle: `${showDay(f.from)} – ${showDay(f.to)}`,
        };
    },
});
