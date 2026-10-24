import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineWidget } from '../dashboard/dashboard.registry';

/** ID card reports (Report Center) and a dashboard widget. */

registerReportCategory('ID cards', 59);

const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'sessionStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];
const between = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lt: new Date(dayDate(f.to).getTime() + 86_400_000) };
};
const REASON: Record<string, string> = { new: 'New', lost: 'Lost', damaged: 'Damaged', changed: 'Details changed' };
const STATUS: Record<string, string> = { active: 'Active', replaced: 'Replaced', cancelled: 'Cancelled' };

const people = async (cards: { studentId: string | null; staffId: string | null }[]) => {
    const year = await currentYear();
    const sIds = cards.map((c) => c.studentId!).filter(Boolean);
    const [st, sf, enrol] = await Promise.all([
        db.student.findMany({ where: { id: { in: sIds } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.staff.findMany({ where: { id: { in: cards.map((c) => c.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
        year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: sIds } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [],
    ]);
    return (c: { studentId: string | null; staffId: string | null }) => {
        if (c.studentId) {
            const s = st.find((x) => x.id === c.studentId);
            const e = enrol.find((x) => x.studentId === c.studentId);
            return { name: s ? fullName(s) : '', code: s?.admissionNo ?? '', group: e ? sectionLabel(e.section) : 'Students' };
        }
        const s = sf.find((x) => x.id === c.staffId);
        return { name: s ? fullName(s) : '', code: s?.employeeCode ?? '', group: 'Staff' };
    };
};

defineReport({
    key: 'idcards_printed',
    category: 'ID cards',
    label: 'ID cards given',
    description: 'Cards given in a period, by section (and staff), with the card number, reason and status.',
    permissions: ['idcard.view', 'idcard.print'],
    orientation: 'landscape',
    filters: [...range, { key: 'type', label: 'For', type: 'select', default: '', options: [{ value: '', label: 'Students and staff' }, { value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }] }],
    columns: [
        { key: 'date', label: 'Given on', type: 'date', width: 0.7 },
        { key: 'cardNo', label: 'Card no.', type: 'text', width: 0.8 },
        { key: 'name', label: 'Name', type: 'text', width: 1.6 },
        { key: 'code', label: 'Adm. no / emp. code', type: 'text', width: 0.9 },
        { key: 'reason', label: 'Reason', type: 'text', width: 0.8 },
        { key: 'prints', label: 'Prints', type: 'number', width: 0.5, total: true },
        { key: 'status', label: 'Status', type: 'text', width: 0.7 },
    ],
    async run(f) {
        const cards = await db.idCard.findMany({ where: { createdAt: between(f), ...(f.type ? { holderType: f.type } : {}) }, orderBy: { createdAt: 'asc' } });
        const who = await people(cards);
        return {
            subtitle: `${f.from} – ${f.to}`,
            groupedBy: 'Section',
            rows: cards
                .map((c) => {
                    const p = who(c);
                    return { groupKey: p.group, groupLabel: p.group, date: isoOf(c.createdAt), cardNo: c.cardNo, name: p.name, code: p.code, reason: REASON[c.reason] ?? c.reason, prints: c.printCount, status: STATUS[c.status] ?? c.status };
                })
                .sort((a, b) => (a.groupLabel === 'Staff' ? 1 : 0) - (b.groupLabel === 'Staff' ? 1 : 0) || a.groupLabel.localeCompare(b.groupLabel, 'en', { numeric: true }) || a.name.localeCompare(b.name)),
        };
    },
});

defineReport({
    key: 'idcards_duplicates',
    category: 'ID cards',
    label: 'Duplicate ID cards',
    description: 'Cards replaced (lost, damaged, details changed) in a period, with the fee charged.',
    permissions: ['idcard.view', 'idcard.print'],
    orientation: 'portrait',
    filters: range,
    columns: [
        { key: 'date', label: 'Date', type: 'date', width: 0.7 },
        { key: 'name', label: 'Name', type: 'text', width: 1.6 },
        { key: 'group', label: 'Section', type: 'text', width: 0.7 },
        { key: 'cardNo', label: 'New card', type: 'text', width: 0.8 },
        { key: 'reason', label: 'Reason', type: 'text', width: 0.8 },
        { key: 'fee', label: 'Fee', type: 'money', width: 0.6, total: true },
    ],
    async run(f) {
        const cards = await db.idCard.findMany({ where: { createdAt: between(f), reason: { not: 'new' } }, orderBy: { createdAt: 'asc' } });
        const who = await people(cards);
        return { subtitle: `${f.from} – ${f.to}`, rows: cards.map((c) => ({ date: isoOf(c.createdAt), ...who(c), cardNo: c.cardNo, reason: REASON[c.reason] ?? c.reason, fee: c.fee ?? 0 })) };
    },
});

defineReport({
    key: 'idcards_no_photo',
    category: 'ID cards',
    label: 'Students and staff without a photo',
    description: 'Who still needs a photo before the cards are printed, by section.',
    permissions: ['idcard.view', 'idcard.print', 'idcard.photos'],
    orientation: 'portrait',
    about: 'student',
    filters: [{ key: 'type', label: 'For', type: 'select', default: 'student', options: [{ value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }] }],
    columns: [
        { key: 'name', label: 'Name', type: 'text', width: 1.8 },
        { key: 'code', label: 'Adm. no / emp. code', type: 'text', width: 1 },
        { key: 'roll', label: 'Roll', type: 'text', width: 0.5 },
    ],
    async run(f) {
        if (f.type === 'staff') {
            const rows = await db.staff.findMany({ where: { status: 'working', photoFileId: null }, orderBy: { firstName: 'asc' }, select: { firstName: true, middleName: true, lastName: true, employeeCode: true } });
            return { rows: rows.map((s) => ({ name: fullName(s), code: s.employeeCode, roll: '' })) };
        }
        const year = await currentYear();
        if (!year) return { rows: [] };
        const e = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active', photoFileId: null } }, select: { rollNumber: true, section: { select: { id: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } });
        return {
            groupedBy: 'Section',
            rows: e
                .sort((a, b) => a.section.schoolClass.sortOrder - b.section.schoolClass.sortOrder || a.section.sortOrder - b.section.sortOrder || (a.rollNumber ?? 0) - (b.rollNumber ?? 0))
                .map((x) => ({ groupKey: x.section.id, groupLabel: sectionLabel(x.section), studentId: x.student.id, name: fullName(x.student), code: x.student.admissionNo, roll: x.rollNumber ? String(x.rollNumber) : '' })),
        };
    },
});

defineWidget({
    key: 'idcards_status',
    label: 'ID cards',
    description: 'Active students without a card or a photo, and photos from parents waiting for approval.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/id-cards',
    permissions: ['idcard.print'],
    cacheSeconds: 600,
    async load() {
        const [students, withCard, noPhoto, waiting] = await Promise.all([db.student.count({ where: { status: 'active' } }), db.idCard.count({ where: { holderType: 'student', status: 'active', studentId: { not: null } } }), db.student.count({ where: { status: 'active', photoFileId: null } }), db.idPhotoRequest.count({ where: { status: 'pending' } })]);
        const without = Math.max(0, students - withCard);
        return { value: without, caption: 'students without an ID card', tone: waiting ? 'warn' : 'neutral', sub: [{ label: 'Without a photo', value: noPhoto, tone: noPhoto ? 'warn' : undefined }, { label: 'Photos to approve', value: waiting, tone: waiting ? 'warn' : undefined }] };
    },
});
