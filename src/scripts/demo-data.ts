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
import { createDemoAlerts } from '../modules/alerts/demo-alerts';
import { createDemoHomework } from '../modules/homework/demo-homework';
import { createDemoQuestions } from '../modules/questions/demo-questions';
import { addDemoSyllabus } from '../modules/questions/demo-syllabus';
import { createDemoTests } from '../modules/tests/demo-tests';
import { createDemoLearn } from '../modules/learn/demo-learn';
import { createDemoTransport } from '../modules/transport/demo-transport';
import { createDemoLibrary } from '../modules/library/demo-library';
import { createDemoPtm } from '../modules/ptm/demo-ptm';
import { createDemoVisitors } from '../modules/visitors/demo-visitors';
import { createDemoComplaints } from '../modules/complaints/demo-complaints';
import { createDemoDiscipline } from '../modules/discipline/demo-discipline';
import { createDemoFeedback } from '../modules/feedback/demo-feedback';
import { createDemoUploads } from '../modules/uploads/demo-uploads';
import { createDemoAssets } from '../modules/assets/demo-assets';
import { createDemoIdCards } from '../modules/idcards/demo-idcards';
import { createDemoInventory } from '../modules/inventory/demo-inventory';
import { createDemoExams2 } from '../modules/exams/demo-exams2';
import { createDemoPayroll } from '../modules/payroll/demo-payroll';
import { createDemoAccounts } from '../modules/accounts/demo-accounts';
import { createDemoHostel } from '../modules/hostel/demo-hostel';
import { createDemoMess } from '../modules/mess/demo-mess';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    const { values } = parseArgs({ options: { school: { type: 'string' }, clear: { type: 'boolean' }, attendance: { type: 'boolean' }, leave: { type: 'boolean' }, notices: { type: 'boolean' }, exams: { type: 'boolean' }, alerts: { type: 'boolean' }, homework: { type: 'boolean' }, questions: { type: 'boolean' }, tests: { type: 'boolean' }, learn: { type: 'boolean' }, syllabus: { type: 'boolean' }, transport: { type: 'boolean' }, library: { type: 'boolean' }, ptm: { type: 'boolean' }, visitors: { type: 'boolean' }, complaints: { type: 'boolean' }, discipline: { type: 'boolean' }, feedback: { type: 'boolean' }, uploads: { type: 'boolean' }, assets: { type: 'boolean' }, idcards: { type: 'boolean' }, inventory: { type: 'boolean' }, exams2: { type: 'boolean' }, payroll: { type: 'boolean' }, accounts: { type: 'boolean' }, hostel: { type: 'boolean' }, mess: { type: 'boolean' } } });
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
    if (values.syllabus) {
        // Only the chapters still missing, for every class's subjects.
        const n = await runAsTenant(tenant.id, addDemoSyllabus);
        out(`${tenant.name}: ${n} chapters added.`);
        return;
    }
    if (values.learn) {
        // Only AI learning (tutor conversations and practice quizzes).
        const r = await runAsTenant(tenant.id, createDemoLearn);
        out(`${tenant.name}: ${r.chats} tutor conversations, ${r.quizzes} practice quizzes.`);
        return;
    }
    if (values.tests) {
        // Only online tests (after the question bank).
        const r = await runAsTenant(tenant.id, createDemoTests);
        out(`${tenant.name}: ${r.tests} online tests, ${r.attempts} attempts.`);
        return;
    }
    if (values.questions) {
        // Only the syllabus and question bank.
        const r = await runAsTenant(tenant.id, createDemoQuestions);
        out(`${tenant.name}: ${r.chapters} chapters, ${r.questions} questions.`);
        return;
    }
    if (values.hostel) {
        // Only the hostel (then the mess, which takes the boarders), for a school that already has its demo students and staff.
        const h = await runAsTenant(tenant.id, createDemoHostel);
        out(`${tenant.name}: ${h.hostels} hostels, ${h.boarders} boarders${h.wardens.length ? `; warden logins ${h.wardens.join(', ')}` : ''}.`);
        return;
    }
    if (values.mess) {
        // Only the mess, after the hostel demo.
        const r = await runAsTenant(tenant.id, createDemoMess);
        out(`${tenant.name}: ${r.plans} mess plans, ${r.members} members, ${r.served} meals served${r.incharge ? `; mess in-charge login ${r.incharge}` : ''}.`);
        return;
    }
    if (values.accounts) {
        // Only accounts, for a school that already has its demo fees, payroll and store.
        const r = await runAsTenant(tenant.id, createDemoAccounts);
        out(`${tenant.name}: ${r.vouchers} vouchers.`);
        return;
    }
    if (values.payroll) {
        // Only payroll, for a school that already has its demo staff and attendance.
        const r = await runAsTenant(tenant.id, createDemoPayroll);
        out(`${tenant.name}: salaries for ${r.staff} staff, ${r.months} months of payroll.`);
        return;
    }
    if (values.exams2) {
        // Only the Exams v2 demo, for a school that already has its demo exams, rooms and question bank.
        const r = await runAsTenant(tenant.id, createDemoExams2);
        out(`${tenant.name}: ${r.exam ?? 'nothing new'}; ${r.seats} seats planned.`);
        return;
    }
    if (values.inventory) {
        // Only inventory, for a school that already has its demo staff and students.
        const r = await runAsTenant(tenant.id, createDemoInventory);
        out(`${tenant.name}: ${r.items} items, ${r.moves} stock movements${r.storekeeper ? `; storekeeper login ${r.storekeeper}` : ''}.`);
        return;
    }
    if (values.idcards) {
        // Only ID cards, for a school that already has its demo students and staff.
        const r = await runAsTenant(tenant.id, createDemoIdCards);
        out(`${tenant.name}: ${r.designs} card designs, ${r.cards} cards, ${r.photos} photos.`);
        return;
    }
    if (values.assets) {
        // Only assets, for a school that already has its demo staff.
        const r = await runAsTenant(tenant.id, createDemoAssets);
        out(`${tenant.name}: ${r.assets} assets, ${r.issues} problems.`);
        return;
    }
    if (values.uploads) {
        // Only shared files, for a school that already has its demo people.
        const r = await runAsTenant(tenant.id, createDemoUploads);
        out(`${tenant.name}: ${r.folders} folders, ${r.files} shared files.`);
        return;
    }
    if (values.feedback) {
        // Only teacher feedback, for a school that already has its demo teachers and students.
        const r = await runAsTenant(tenant.id, createDemoFeedback);
        out(`${tenant.name}: ${r.rounds} feedback rounds, ${r.responses} responses.`);
        return;
    }
    if (values.discipline) {
        // Only discipline, for a school that already has its demo people.
        const r = await runAsTenant(tenant.id, createDemoDiscipline);
        out(`${tenant.name}: ${r.incidents} incidents, ${r.positives} positive notes.`);
        return;
    }
    if (values.complaints) {
        // Only complaints, for a school that already has its demo people.
        const r = await runAsTenant(tenant.id, createDemoComplaints);
        out(`${tenant.name}: ${r.complaints} complaints.`);
        return;
    }
    if (values.visitors) {
        // Only the gate, for a school that already has its demo staff and students.
        const r = await runAsTenant(tenant.id, createDemoVisitors);
        out(`${tenant.name}: ${r.visits} visits (${r.inside} inside now), ${r.pickups} early pickups. Security guard login: ${r.guard ?? 'none'} (password Demo@2026).`);
        return;
    }
    if (values.ptm) {
        // Only PTMs, for a school that already has its demo teachers and students.
        const r = await runAsTenant(tenant.id, createDemoPtm);
        out(`${tenant.name}: ${r.ptms} PTMs, ${r.meetings} meetings / bookings.`);
        return;
    }
    if (values.library) {
        // Only the library, for a school that already has its demo staff and students.
        const r = await runAsTenant(tenant.id, createDemoLibrary);
        out(`${tenant.name}: ${r.books} titles, ${r.copies} copies, ${r.loans} loans (${r.out} out now), ${r.fines} fines. Librarian login: ${r.librarian ?? 'none'} (password Demo@2026).`);
        return;
    }
    if (values.transport) {
        // Only transport, for a school that already has its demo staff and students.
        const r = await runAsTenant(tenant.id, createDemoTransport);
        out(`${tenant.name}: ${r.routes} routes, ${r.students} students on the buses, ${r.trips} past trips. Driver logins: ${r.drivers.join(', ') || 'none'} (password Demo@2026).`);
        return;
    }
    if (values.homework) {
        // Only homework, for a school that already has its demo teachers and students.
        const r = await runAsTenant(tenant.id, createDemoHomework);
        out(`${tenant.name}: ${r.homework} homework, ${r.submissions} handed in / checked.`);
        return;
    }
    if (values.alerts) {
        // Only messages and notifications, for a school that already has its demo people.
        const r = await runAsTenant(tenant.id, createDemoAlerts);
        out(`${tenant.name}: ${r.messages} sent messages, ${r.notifications} notifications, ${r.log} alert log entries.`);
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
    out(`${tenant.name}: ${r.alerts.messages} sent messages, ${r.alerts.notifications} notifications.`);
    out(`${tenant.name}: ${r.homework.homework} homework, ${r.homework.submissions} handed in / checked.`);
    out(`${tenant.name}: ${r.questions.chapters} chapters, ${r.questions.questions} questions.`);
    out(`${tenant.name}: ${r.tests.tests} online tests, ${r.tests.attempts} attempts.`);
    out(`${tenant.name}: ${r.transport.routes} bus routes, ${r.transport.students} students on the buses; driver logins: ${r.transport.drivers.join(', ')}.`);
    out(`${tenant.name}: ${r.library.books} library titles, ${r.library.copies} copies, ${r.library.out} books out; librarian login: ${r.library.librarian}.`);
    out(`${tenant.name}: ${r.ptm.ptms} PTMs, ${r.ptm.meetings} PTM meetings / bookings.`);
    out(`${tenant.name}: ${r.visitors.visits} visits, ${r.visitors.pickups} early pickups; security guard login: ${r.visitors.guard}.`);
    out(`${tenant.name}: ${r.complaints.complaints} complaints.`);
    out(`${tenant.name}: ${r.discipline.incidents} incidents, ${r.discipline.positives} positive notes.`);
    out(`${tenant.name}: ${r.feedback.rounds} teacher feedback rounds, ${r.feedback.responses} responses.`);
    out(`${tenant.name}: ${r.uploads.folders} shared folders, ${r.uploads.files} files.`);
    out(`${tenant.name}: ${r.assets.assets} assets, ${r.assets.issues} problems.`);
    out(`${tenant.name}: ${r.idcards.designs} card designs, ${r.idcards.cards} ID cards.`);
    out(`${tenant.name}: ${r.inventory.items} store items${r.inventory.storekeeper ? `; storekeeper login ${r.inventory.storekeeper}` : ''}.`);
    out(`${tenant.name}: ${r.hostel.hostels} hostels, ${r.hostel.boarders} boarders${r.hostel.wardens.length ? `; warden logins ${r.hostel.wardens.join(', ')}` : ''}.`);
    out(`${tenant.name}: ${r.mess.members} mess members${r.mess.incharge ? `; mess in-charge login ${r.mess.incharge}` : ''}.`);
    out(`${tenant.name}: ${r.learn.chats} tutor conversations, ${r.learn.quizzes} practice quizzes.`);
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
