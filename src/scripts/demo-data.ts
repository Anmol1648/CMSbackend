/**
 * Demo data for showing the system (students, parents, class teachers), or removing it again.
 *
 *   npm run demo:seed -- --school dps
 *   npm run demo:clear -- --school dps
 */
import { parseArgs } from 'util';
import '../config/env';
import '../modules/registry';
import { db } from '../core/db';
import { cache } from '../core/cache';
import { runAsSystem, runAsTenant } from '../core/context';
import { clearDemoData, createDemoData, DEMO_PASSWORD } from '../modules/students/demo-data';
import { createDemoAttendance } from '../modules/attendance/demo-attendance';
import { createDemoLeave } from '../modules/leave/demo-leave';
import { createDemoNotices } from '../modules/notices/demo-notices';
import { createDemoExams } from '../modules/exams/demo-exams';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const { values } = parseArgs({ options: { school: { type: 'string' }, clear: { type: 'boolean' }, attendance: { type: 'boolean' }, leave: { type: 'boolean' }, notices: { type: 'boolean' }, exams: { type: 'boolean' } } });
    if (!values.school) {
        out('Usage: npm run demo:seed -- --school <code>   |   npm run demo:clear -- --school <code>');
        process.exitCode = 1;
        return;
    }
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school!.toLowerCase() } }));
    if (!tenant) {
        out(`No school with code "${values.school}".`);
        process.exitCode = 1;
        return;
    }
    if (values.clear) {
        const r = await runAsTenant(tenant.id, clearDemoData);
        out(`${tenant.name}: removed ${r.students} demo students, ${r.families} families, ${r.staff} staff, ${r.enquiries} enquiries, ${r.receipts} fee receipts and ${r.logins} demo logins.${r.counterReset ? ' Numbers start again from the first.' : ''}`);
        return;
    }
    if (values.attendance) {
        // Only attendance, for a school that already has its demo students (added after them).
        const r = await runAsTenant(tenant.id, async () => {
            const year = await db.academicYear.findFirst({ where: { isCurrent: true } });
            if (!year) throw new Error('No current academic year');
            return createDemoAttendance(year);
        });
        out(`${tenant.name}: ${r.holidays} holidays, ${r.registers} registers over ${r.days} school days, ${r.staffDays} staff check-ins.`);
        return;
    }
    if (values.leave) {
        // Only staff leave, for a school that already has its demo staff (added after them).
        const r = await runAsTenant(tenant.id, createDemoLeave);
        out(`${tenant.name}: ${r.leaves} staff leaves (${r.attendance} days in the staff register), ${r.compOffs} comp-offs.`);
        return;
    }
    if (values.exams) {
        // Only exams, for a school that already has its demo students.
        const r = await runAsTenant(tenant.id, createDemoExams);
        out(`${tenant.name}: ${r.exams} exams, ${r.marks} marks.`);
        return;
    }
    if (values.notices) {
        // Only notices and events, for a school that already has its demo people.
        const r = await runAsTenant(tenant.id, createDemoNotices);
        out(`${tenant.name}: ${r.notices} notices (${r.reads} reads), ${r.events} events.`);
        return;
    }
    out(`${tenant.name}: creating demo data (this takes a minute)…`);
    const r = await runAsTenant(tenant.id, () => createDemoData());
    out(`${tenant.name}: ${r.students} students in ${r.sections} sections of ${r.year}, ${r.families} families, ${r.staff.staff} staff (${r.staff.logins} with logins, ${r.staff.assignments} subject-teacher assignments), ${r.studentLogins} student logins.`);
    out(`${tenant.name}: ${r.enquiries.enquiries} admission enquiries, ${r.fees.receipts} fee receipts, ${r.fees.parentLogins} parent logins (username = the parent's mobile).`);
    out(`${tenant.name}: attendance for the last ${r.attendance.days} school days (${r.attendance.registers} registers), ${r.attendance.staffDays} staff check-ins, ${r.attendance.holidays} holidays.`);
    out(`${tenant.name}: ${r.leave.leaves} staff leaves, ${r.leave.compOffs} comp-offs.`);
    out(`${tenant.name}: ${r.notices.notices} notices, ${r.notices.events} events.`);
    if (r.timetable.generated) out(`${tenant.name}: timetable published (${r.timetable.placed} of ${r.timetable.wanted} periods placed), ${r.timetable.substitutions} substitution periods today.`);
    out('');
    out(`Every demo login uses the password ${DEMO_PASSWORD}`);
    if (r.staff.sampleTeacher) out(`  class teacher: ${r.staff.sampleTeacher}   (sees only their own sections' students)`);
    if (r.studentLogins && r.sampleStudent) out(`  student:       ${r.sampleStudent.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}   (admission no ${r.sampleStudent})`);
    out('Remove it all later with: npm run demo:clear -- --school ' + tenant.code);
};

main()
    .catch((err) => {
        process.stderr.write(`${(err as Error).message ?? err}\n`);
        process.exitCode = 1;
    })
    .finally(() => Promise.allSettled([db.$disconnect(), cache.close()]));
