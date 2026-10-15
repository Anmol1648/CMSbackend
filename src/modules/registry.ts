/**
 * Loads every module's permission and menu declarations. Imported once by app.ts (and tests),
 * before the registry is synced to the database. Add new modules here.
 */
import './school-profile/school-profile.permissions';
import './rbac/rbac.permissions';
import './settings/settings.permissions';
import './audit/audit.permissions';
import './auth/auth.emails';
