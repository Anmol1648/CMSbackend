import { db } from '../../core/db';
import { defineDataSource, personName } from '../reports/datasources.registry';

/** The published timetable for the Report Builder: periods per week by teacher, class and subject. */

defineDataSource({
    key: 'timetable_load',
    label: 'Timetable (periods per week)',
    description: 'From the published timetable: how many periods a week each teacher takes, in which class and subject.',
    category: 'Timetable',
    permissions: ['timetable.view'],
    params: [{ key: 'year', label: 'Session', type: 'year', required: true, default: 'current' }],
    fields: [
        { key: 'teacher', label: 'Teacher', type: 'text' },
        { key: 'employeeCode', label: 'Employee code', type: 'text' },
        { key: 'designation', label: 'Designation', type: 'text' },
        { key: 'className', label: 'Class', type: 'text' },
        { key: 'section', label: 'Class and section', type: 'text' },
        { key: 'subject', label: 'Subject', type: 'text' },
        { key: 'subjectCode', label: 'Subject code', type: 'text' },
        { key: 'periods', label: 'Periods a week', type: 'number' },
    ],
    async load(p) {
        const tt = await db.timetable.findFirst({ where: { academicYearId: p.year, status: 'published' }, orderBy: { publishedAt: 'desc' }, select: { id: true } });
        if (!tt) return [];
        const entries = await db.ttEntry.findMany({
            where: { timetableId: tt.id },
            select: {
                staffId: true,
                sectionId: true,
                subjectId: true,
                staff: { select: { employeeCode: true, firstName: true, middleName: true, lastName: true, designation: { select: { name: true } } } },
                section: { select: { name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } },
                subject: { select: { name: true, code: true, sortOrder: true } },
            },
        });
        const rows = new Map<string, { order: string; row: Record<string, unknown> }>();
        for (const e of entries) {
            const key = `${e.staffId ?? '-'}|${e.sectionId}|${e.subjectId}`;
            const had = rows.get(key);
            if (had) {
                (had.row.periods as number)++;
                continue;
            }
            const teacher = personName(e.staff) ?? 'No teacher';
            rows.set(key, {
                order: `${teacher}|${String(e.section.schoolClass.sortOrder).padStart(4, '0')}${String(e.section.sortOrder).padStart(4, '0')}|${String(e.subject.sortOrder).padStart(4, '0')}`,
                row: {
                    teacher,
                    employeeCode: e.staff?.employeeCode ?? null,
                    designation: e.staff?.designation?.name ?? null,
                    className: e.section.schoolClass.name,
                    section: `${e.section.schoolClass.shortName ?? e.section.schoolClass.name}-${e.section.name}`,
                    subject: e.subject.name,
                    subjectCode: e.subject.code,
                    periods: 1,
                },
            });
        }
        return [...rows.values()].sort((a, b) => a.order.localeCompare(b.order)).map((r) => r.row);
    },
});
