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
import { registerMasterImports } from './masters/masters.permissions';

// Last: one Excel import per master list, once every module above has declared its lists.
registerMasterImports();
