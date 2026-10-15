# Foundation Design — School ERP (cmsbackend + cmsfrontend)

Status: **draft for review**. Nothing here is built yet. Mark changes inline or tell me; once you approve, the build follows the order in section 11.

---

## 1. What the foundation is

The foundation is everything every later module (Academic, Students, Staff, Attendance, Fees, …) relies on:

- the backend skeleton and its rules,
- schools (tenants) and the school profile,
- login and accounts,
- roles and permissions (with menus),
- System Settings,
- Audit Trail,
- files and Excel import/export,
- the frontend shell and UI kit.

Once it is done, building a module means adding tables, routes and pages. Security, settings, audit and permissions come for free.

### Principles

1. **Everything configurable.** Code supplies sensible defaults. Schools change behaviour through System Settings (rules), setup screens (lists and masters) or Roles & Permissions (who can do what).
2. **The database protects itself.** Real foreign keys, unique rules and NOT NULL where the data must exist. No tables are created or altered by the app at runtime.
3. **One way to do each thing.** One list API shape, one error format, one form pattern, one dialog component. No `alert()` or `confirm()`.
4. **Secure by default.** Every API route needs a login and a permission unless it is explicitly public. Secrets are never logged or returned.
5. **Tenant-ready from the first table.** Every school-owned row carries `tenant_id`.

---

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Product | School only (no college programs/semesters) |
| Architecture | One backend app with modules (modular monolith); one frontend |
| Database | PostgreSQL (Neon) through Prisma; migrations only; fresh clean baseline |
| Multi-tenancy | One shared database, `tenant_id` on every school-owned table (details in section 4) |
| MFA | Kept, optional per user; a policy setting can require it for some roles |
| Redis | Optional. Used when `REDIS_URL` is set, otherwise an in-memory store (details in section 6.4) |
| Login identifier | Email, username or mobile; which ones are allowed is a setting |
| Logins | Optional per person (staff, students, guardians); only people who sign in get a user account |

---

## 3. Backend structure and conventions

### 3.1 Folders

```
cmsbackend/
  prisma/
    schema.prisma          one schema; each module's models grouped under a comment header
    migrations/            named migrations only (prisma migrate dev --name <what>)
  src/
    server.ts              starts the HTTP server
    app.ts                 express app: security headers, CORS, body limits, request id, routes, errors
    config/
      env.ts               validates environment variables at startup (fails fast, names the missing key)
    core/                  framework code with no business rules
      http/                async handler, response helpers, list-query parser, error classes + handler
      db/                  prisma client, tenant scoping, transaction helper
      auth/                token signing/verification, password hashing, request context
      cache/               store interface: Redis or in-memory
      registry/            permission, menu and settings registries (modules register into them)
      audit/               audit writer
      files/               storage interface (local disk / Cloudinary / S3)
      excel/               template builder, file parser, row validator, exporter
      mail/                mail sender (SMTP), message templates
    modules/
      <module>/
        <module>.routes.ts       routes + which permission each needs
        <module>.controller.ts   HTTP in/out only
        <module>.service.ts      business rules, the only place that touches the DB
        <module>.schemas.ts      zod schemas for request bodies and queries
        <module>.permissions.ts  resources/actions this module adds
        <module>.settings.ts     settings this module adds (if any)
        <module>.menu.ts         sidebar entries this module adds (if any)
        index.ts                 what other modules may import (its public services)
  test/                    integration tests (supertest) and unit tests
  docs/
```

### 3.2 Module boundaries

- A module may import another module only through its `index.ts`, never its internal files or its tables.
- Example: Attendance asks `students.listEnrolled(sectionId, date)`. It never queries the students table directly.
- Cross-module writes that must succeed together run in one transaction (`withTransaction(tx => …)`), with the transaction passed into the services.

### 3.3 API conventions

- **Base path** `/api`. Resources are plural and kebab-case (`/api/users`, `/api/roles`, `/api/system-settings`).
- **Success response** `{ "status": "success", "data": … , "message"?: "…", "timestamp": "…" }` (the envelope the frontend already reads)
- **Error response** `{ "status": "error", "error": { "code": "VALIDATION_ERROR", "message": "…", "details"?: [{ "field": "email", "message": "Invalid email" }] }, "requestId": "…", "timestamp": "…" }`
  - Validation errors list the bad fields. The current code only says "Validation failed".
  - 500 errors never expose internal messages. The `requestId` matches the server log line.
- **Lists:** `GET /api/users?page=1&pageSize=25&sort=name&order=asc&search=ram&filter[status]=active`
  → `{ "data": { "items": [...], "total": 132, "page": 1, "pageSize": 25 } }`
  - Each list declares which fields can be sorted and filtered. Anything else is rejected. This closes the injection class we fixed in the old ERP.
  - `pageSize` is capped (setting, default 100). Exports use the export endpoint, not huge pages.
- **Edits** use `PATCH` with only the changed fields. Edit forms send back `updatedAt`. If the row changed meanwhile, the API answers `409 CONFLICT` ("Someone else changed this record — reload"), so nobody silently overwrites another person's edit.
- **Deletes:** master data with history is deactivated (soft delete), not removed. Hard delete only where nothing refers to the row.

### 3.4 Database conventions

| Rule | Detail |
|---|---|
| Names | Tables plural snake_case (`role_permissions`); columns snake_case; Prisma models PascalCase with `@@map` / `@map` |
| Keys | `id uuid` (database default `gen_random_uuid()`) |
| Tenant | `tenant_id uuid NOT NULL REFERENCES tenants(id)` on every school-owned table; unique rules include it (`UNIQUE (tenant_id, username)`) |
| Audit columns | `created_at timestamptz NOT NULL DEFAULT now()`, `created_by uuid NULL → users`, `updated_at timestamptz NOT NULL`, `updated_by uuid NULL → users`. Set automatically from the request's user |
| Soft delete | `deleted_at timestamptz NULL` (plus `deleted_by`) on tables where history matters; normal queries exclude deleted rows automatically |
| Fixed system states | Prisma enums (e.g. user status). School-specific lists (designations, castes…) are master tables, never enums |
| Money / dates | Money `numeric(12,2)`; calendar dates `date`; moments `timestamptz`, shown in the school's time zone |
| Indexes | Every foreign key indexed; one index per real query pattern; no duplicates |
| Migrations | `npm run db:migrate:dev -- --name <what>` locally; `npm run db:migrate` on deploy. Never `db push` or sync against a shared database |

### 3.5 Quality gates

- `npm run typecheck`, `npm test` and `npm run lint` must pass before a piece counts as done.
- **Tests:** vitest + supertest against a separate **Neon test branch** (a copy of the schema, never the real data). Every module adds tests for its permissions and its main rules.
- **Logging:** one line per request (method, path, status, ms, user, requestId). Expected 4xx errors are one line; unexpected ones include the stack. Passwords, tokens and secrets are never logged.

---

## 4. Schools (multi-tenancy)

### 4.1 How the school is found for a request

1. **Logged-in requests:** the school comes from the access token (`tid` claim), never from a header or the request body.
2. **Login page (before login):** the school is found from the website address (`tenants.domain`, e.g. `erp.greenvalley.in`). If no domain matches, the `DEFAULT_TENANT` from config is used. With one school, everything just works.

### 4.2 How data is kept separate

- **Prisma scoping (always on).** A Prisma extension adds `tenant_id = <current school>` to every read, update and delete on school-owned models, and fills `tenant_id` on create. Code cannot forget it.
- **Raw SQL** is allowed only through one helper that requires the tenant id. A test fails the build if raw SQL appears anywhere else.
- **Isolation tests:** two test schools with the same usernames/codes. Every module's tests check that school A can't read, change or count school B's rows.
- **Postgres row-level security (RLS)** is switched on before a second school is onboarded. It needs a per-transaction `SET` on every query, which costs one extra database round trip. That only becomes worth it when there is a second school, and the server should then run in the same region as the database. The schema and policies are written so this is a switch, not a rewrite.

### 4.3 Creating a school

- For now: a command, `npm run tenant:create -- --name "…" --code … --admin-email …`. It creates the school, its default roles and settings, and the first Super Admin, then prints that admin's one-time password.
- A platform "Schools" screen for running many schools comes later. The current `/api/tenants` page and routes are removed.

---

## 5. Data model (foundation tables)

Every table below also has the standard audit columns from section 3.4 unless noted.

### 5.1 `tenants`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| code | text UNIQUE | short code, e.g. `gvs` |
| name | text | |
| domain | text UNIQUE NULL | web address that resolves to this school |
| status | enum `active / suspended` | suspended → nobody of that school can sign in |

### 5.2 `school_profiles` (one row per school)
`tenant_id` PK → tenants; legal_name; short_name; logo_file_id → files; address_line1, address_line2, city, district, state, pincode, country; phone; email; website; board (CBSE/ICSE/State…); affiliation_no; udise_code; established_year; time_zone (default `Asia/Kolkata`); date_format (default `DD-MM-YYYY`); currency (default `INR`); academic_year_start_month (default April). Shown in the header, on reports, receipts and ID cards.

### 5.3 `users` — only people who sign in
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid | |
| kind | enum `staff / student / guardian / admin` | which kind of person the login belongs to |
| username | text | UNIQUE (tenant_id, username) |
| email | text NULL | UNIQUE (tenant_id, email) when present; no fake placeholder emails |
| mobile | text NULL | UNIQUE (tenant_id, mobile) when present |
| display_name | text | |
| password_hash | text | bcrypt |
| status | enum `active / disabled` | |
| must_change_password | bool | set for first and admin-reset passwords |
| password_changed_at | timestamptz NULL | for password-expiry rules |
| failed_login_count | int | lockout counter |
| locked_until | timestamptz NULL | |
| last_login_at | timestamptz NULL | |
| mfa_enabled | bool | |
| mfa_secret_enc | text NULL | encrypted (AES-GCM); never returned by the API |
| avatar_file_id | uuid NULL → files | |
| deleted_at | timestamptz NULL | |

Personal details (gender, DOB, address, phone numbers) belong to the person record (employee, student, guardian), built in those modules with a nullable `user_id`. This replaces `user_profiles` and the first/last name columns on users.

### 5.4 `user_sessions` — one row per signed-in device
id; tenant_id; user_id → users; refresh_token_hash (SHA-256, never the raw token); user_agent; ip; created_at; last_used_at; expires_at; revoked_at NULL; revoked_reason (`logout / logout_all / password_changed / reuse_detected / admin`). Lets users see and end their own sessions, and admins end anyone's.

### 5.5 `password_resets`
id; tenant_id; user_id; code_hash; expires_at; attempts; used_at NULL; requested_ip.

### 5.6 Roles and permissions
**`permissions`** (system-wide, filled from code at startup, not edited by hand): key PK (e.g. `student.create`); module; resource; action; label; description; `is_sensitive` (e.g. `student.view_sensitive` for Aadhaar/income); `scopes` (which data scopes make sense for it).

**`roles`**: id; tenant_id; name; slug (UNIQUE per school); description; `is_system` (Super Admin; can't be deleted or emptied); `default_for` NULL / `staff` / `student` / `guardian` (given automatically to new logins of that kind); deleted_at.

**`role_permissions`**: role_id → roles; permission_key → permissions; scope enum `all / assigned / own` (default `all`). PK (role_id, permission_key).

**`user_roles`**: user_id; role_id; tenant_id; assigned_by; assigned_at. PK (user_id, role_id).

**`menu_customizations`**: tenant_id; menu_key; label NULL; sort_order NULL; hidden bool. Lets a school rename, reorder or hide sidebar items. The items themselves come from code (section 7.3).

Removed from the current schema: `menus`, `role_menus` (menus come from permissions), `field_permissions` (replaced by sensitive permissions), `widgets` and `role_widget_mapping` (the Dashboard module is redesigned later, without stored raw SQL).

### 5.7 `tenant_settings` — only overrides are stored
tenant_id; key; value jsonb; updated_by; updated_at. PK (tenant_id, key). A setting with no row uses its default from code.

### 5.8 `audit_logs`
id bigserial; tenant_id; at; user_id NULL; action (`create / update / delete / restore / login / login_failed / logout / password_change / password_reset / role_change / permission_change / setting_change / import / export`); entity (e.g. `user`, `role`); entity_id; changes jsonb (`{ "field": [old, new] }`; secret fields always masked); ip; user_agent; request_id. Index (tenant_id, at desc) and (tenant_id, entity, entity_id). Retention period is a setting.

### 5.9 `files`
id; tenant_id; provider (`local / cloudinary / s3`); storage_key; original_name; mime_type; size_bytes; purpose (`avatar / logo / import / document`); uploaded_by; created_at; deleted_at. Every upload goes through this table, so access can be checked and storage can be swapped.

### 5.10 `import_jobs`
id; tenant_id; kind (e.g. `students`); status (`validated / importing / done / failed`); file_id; options jsonb; total_rows; valid_rows; imported_rows; error_rows jsonb (row number + field + message); created_by; created_at; finished_at.

---

## 6. Login and accounts

### 6.1 Sign in
1. The user types an identifier (email / username / mobile, whichever the "Login" settings allow) and a password.
2. Checks run in order:
   - school active,
   - user found and active,
   - not locked,
   - password correct. On failure: count the attempt, and after N failures lock for M minutes (both settings). The message is always "Invalid credentials", so accounts can't be discovered.
3. If MFA is on for the user, or required by policy for their role, the server returns a 5-minute MFA challenge and the user enters the 6-digit code (rate limited).
4. On success: a session row is created and two tokens are issued:
   - **access token:** JWT, RS256, 15 minutes (setting). Claims are the user, the school, the session and `token_use: access`. Permissions are not stored in the token; the server loads them and caches them per user.
   - **refresh token:** a random 256-bit value, stored only as a hash. It is sent as an **httpOnly, Secure, SameSite cookie** limited to `/api/auth`, so page scripts can't read it.
5. If `must_change_password` is set, the access token is marked `pwd_change: true`. Every route except "change password", "who am I" and "logout" answers `403 PASSWORD_CHANGE_REQUIRED` until the password is changed.

### 6.2 Staying signed in and signing out
- **Refresh** swaps the refresh cookie for a new pair (rotation). If an old refresh token is used again, someone copied it: the whole session is revoked and the event is audited.
- **Logout** revokes that session. **Logout everywhere** revokes all the user's sessions. **Password change** revokes all other sessions.
- **Disabling a user or changing their roles** takes effect on their next request: the permission cache is cleared and revoked sessions are checked.

### 6.3 Passwords
- The rules are settings: minimum length (default 8), require a number / letter / symbol, expiry days (default off), "can't reuse the last N" (default 3).
- **Forgot password:** a 6-digit code by email, valid 10 minutes, at most 5 tries. The answer is always "If the account exists, a code was sent". SMS codes can be added later behind the same interface.
- **Admin reset:** the admin gets a one-time password shown once on screen (like the old ERP's "login created" dialog). The user must change it at next sign-in.

### 6.4 Redis or no Redis
A cache-store interface backs login rate limits, the MFA attempt counters, the permission cache and session-revocation checks.
- `REDIS_URL` set → Redis. Required if the backend ever runs more than one server process.
- Not set → in-memory store. Fine for one server process; counters reset when it restarts.

### 6.5 Creating logins for people (used by the Staff / Student / Guardian modules)
The account service `createLogin({ kind, personName, email?, mobile?, preferredUsername? })` works like this:
- **username** follows the setting for that kind (admission no / name / mobile / email), made unique with a number suffix;
- **first password** is random and readable, or date of birth, per setting;
- `must_change_password = true`, and the kind's default role is assigned;
- the login is returned once (shown in the "Login created" dialog). A welcome email is sent only if the person has a real email and the setting is on.

---

## 7. Roles and permissions

### 7.1 Permission registry
Each module declares its permissions in `<module>.permissions.ts`:
```ts
registerPermissions('students', [
  { resource: 'student', actions: ['view', 'create', 'update', 'delete', 'export', 'import'], scopes: ['all', 'assigned', 'own'] },
  { resource: 'student', actions: ['view_sensitive'], sensitive: true },
]);
```
At startup the registry is synced into the `permissions` table. New permissions appear on the Roles screen automatically.

### 7.2 Checking permissions
- Each route states its permission: `router.get('/', can('student.view'), …)`. A route with no `can(...)` and no explicit `publicRoute()` **fails at startup**, so no endpoint can ship unprotected by accident.
- **Data scope:**
  - `all` = everything in the school;
  - `assigned` = only the classes/sections the user is assigned to (the Academic/Staff modules provide the assignment lookup);
  - `own` = only rows linked to the user (a student's own record, a guardian's own children).
  - The service receives the resolved scope and filters with it. List and detail endpoints both apply it.
- **Super Admin** (system role) has every permission with scope `all` and can't be locked out. The last active Super Admin can't be disabled or have the role removed.
- There is no "audit mode": the new system enforces from day one.

### 7.3 Menus from permissions
Each module declares its pages in `<module>.menu.ts`: key, label, icon, route, group, order and the permission needed to see it. The sidebar shows a page only if the user holds that permission. `menu_customizations` lets the school rename, reorder or hide items. A separate menu-to-role mapping is no longer needed.

### 7.4 Default roles created with a school
Super Admin (system), School Admin, Principal, Teacher, Class Teacher, Office Staff, Accountant, Student, Guardian. Each starts with a least-privilege permission set and can be edited or cloned.

---

## 8. System Settings

### 8.1 Settings registry
Each setting is declared in code with: key, group, label, help text, type (`boolean / number / text / select / multiselect / time / json`), default, validation (min/max/options), and who can edit it (default: Super Admin). The System Settings screen is generated from the registry, grouped, with a "changed from default" marker and a "reset to default" button. Every change is audited with old and new values. Code reads values with `settings.get(tenantId, 'security.lockout_attempts')`, cached and cleared on change.

### 8.2 Foundation settings (modules add their own groups later)
| Group | Settings (default) |
|---|---|
| Login | allowed identifiers (email, username, mobile); show "forgot password" (on) |
| Security | lockout after N failures (5); lock minutes (15); access token minutes (15); session days (7); remember-me days (30); MFA policy: off / optional / required for chosen roles (optional) |
| Passwords | min length (8); need number (on); need symbol (off); expiry days (0 = never); remember last N (3) |
| Accounts | username source per kind; first password: random / date of birth (random); welcome email (on); default role per kind |
| Locale | date format (DD-MM-YYYY); time format (12h); week starts (Monday) — time zone lives in the school profile |
| Lists & export | default page size (25); max page size (100); max export rows (10,000) |
| Uploads | max file size MB (5); allowed types (images, pdf, xlsx); max import rows (1,000) |
| Audit | keep audit logs for N days (1,095) |

---

## 9. Audit, files and Excel

### 9.1 Audit Trail
- Data changes are recorded automatically by the Prisma layer, inside the same transaction, as field-level `[old, new]` diffs. Secret fields are masked.
- Sign-ins (success and failure), sign-outs, permission/role/setting changes, imports and exports are recorded explicitly.
- **Audit Trail screen:** filter by date, user, action, entity, or a specific record. Every record's detail page can show "History".

### 9.2 Files
Uploads go through `files`: size and type checks from settings, and the content type is checked from the file itself, not the name. The storage provider comes from config (local disk for development, Cloudinary or S3 for production). Downloads check permission through the owning record.

### 9.3 Excel import/export (one engine, used by every module)
- **Template:** built from the module's field list and current settings. It has required columns marked, dropdowns filled from masters, a sample row, and an Instructions sheet.
- **Upload → validate** (nothing saved): per-row errors for required fields, formats, master values, and duplicates within the file and against the database. Shown on screen and downloadable as an "errors" file.
- **Import:** valid rows are imported in batches, bad rows skipped. The result is an `import_jobs` record with a downloadable report, and the import is audited.
- **Export:** of the current list view (same filters), capped by the export-rows setting, audited.

---

## 10. Frontend foundation (cmsfrontend)

| Area | Decision |
|---|---|
| Framework | Next.js 14 App Router + TypeScript + Tailwind (as now) |
| Server data | TanStack Query only. **Remove Redux**: auth state lives in a small React context fed by `/api/auth/me` |
| API client | One axios client: access token kept in memory, refresh through the httpOnly cookie on 401 (one refresh at a time, queued requests replayed), standard error → toast mapping |
| Forms | react-hook-form + zod; field errors from the API's `details` shown under the right input |
| UI kit | Review and keep the existing components (DataTable, Modal, Drawer, Toast, Select, DatePicker, FileUpload, Tabs…). DataTable gets server paging/sort/filter, column chooser and export. One ConfirmDialog; no `alert()` / `confirm()` |
| Permissions | `useCan('student.create')` and `<Can permission="…">`; a page guard redirects to "No access" |
| Shell | Header (school logo/name from the profile, user menu), sidebar from `/api/me/menu`, breadcrumbs, dark/light theme |
| Pages in the foundation | Sign in, MFA code, Forgot / Reset password, Forced password change, My profile (password, MFA, my sessions), Users, Roles & Permissions (matrix with scopes), System Settings, Audit Trail, School Profile, No-access and Not-found pages |
| Removed | College pages (`college-admin`, `faculty`), Tenants page, Dashboard-management/widget editor (comes back with the Dashboard module), Role simulator (replaced by "Who has access" on the Roles screen) |

---

## 11. Build order

| # | Piece | Done when |
|---|---|---|
| F1 | Skeleton and conventions | env validation, request id, security headers, list-query helper, error format, cache store, test setup on a Neon test branch; startup check for unprotected routes |
| F2 | Fresh schema, tenants, School Profile | clean baseline migration on a fresh database (old cms data and the 2 leftover per-school databases dropped); `tenant:create` command; tenant scoping + isolation tests |
| F3 | Login and accounts | everything in section 6, with tests (lockout, MFA, rotation, reuse detection, forced change, reset) |
| F4 | Roles and permissions | registry, scopes, Super Admin guard, menus from permissions, Roles & Users screens |
| F5 | System Settings | registry + generated screen + audit of changes |
| F6 | Audit Trail | automatic diffs + explicit events + screen + record history |
| F7 | Frontend shell and UI kit | section 10; the old pages removed |
| F8 | Files and Excel engine | uploads, templates, validate/import/export, demonstrated on the Users list |

Each piece is reviewed and tested before the next starts. After F8 the first business module begins (**Academic setup**: sessions, classes, sections, subjects).

---

## 12. Questions for you

1. **Refresh token in an httpOnly cookie** (section 6.1) instead of localStorage. This is safer: scripts can't steal it. It needs the frontend and backend on the same site in production (e.g. `erp.school.in` and `api.erp.school.in`). OK?
2. **Creating schools by command** for now (section 4.3), with no Schools screen until you have a second school. OK?
3. **Dashboard widgets removed** until the Dashboard module (they store raw SQL, which isn't safe to keep). OK?
4. **Hosting region:** where will the backend run in production? The database should be in the same region; that was the main reason login was slow in the old ERP.
5. **Default roles** (section 7.4): add or remove any?
