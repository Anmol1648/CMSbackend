/**
 * Loads every module's permission and menu declarations. Imported once by app.ts (and tests),
 * before the registry is synced to the database. Add new modules here.
 */
import './school-profile/school-profile.permissions';
import './rbac/rbac.permissions';
import './settings/settings.permissions';
import './audit/audit.permissions';
import './auth/auth.emails';
import './academic/academic.permissions';
import './students/students.permissions';
import './staff/staff.permissions';
import './admissions/admissions.permissions';
import './fees/fees.permissions';
import './timetable/timetable.permissions';
import './documents/documents.permissions';
import './fees/fee.documents';
import './reports/reports.permissions';
import './fees/fee.reports';
import './admissions/admission.reports';
import './students/student.datasources';
import './staff/staff.datasources';
import './fees/fee.datasources';
import './admissions/admission.datasources';
import './timetable/timetable.datasources';
import './attendance/attendance.permissions';
import './attendance/attendance.reports';
import './leave/leave.permissions';
import './leave/leave.reports';
import './notices/notices.permissions';
import './notices/notices.reports';
import { registerMasterImports } from './masters/masters.permissions';

// Last: one Excel import per master list, once every module above has declared its lists.
registerMasterImports();
