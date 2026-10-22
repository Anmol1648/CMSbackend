import express, { Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import { env, isProduction } from './config/env';
import { globalErrorHandler } from './core/error-handler';
import { errorResponse } from './core/response';
import { getRequestId } from './core/context';
import { assertRoutesProtected, listRoutes } from './core/http/route-guard';
import { findPermissionDef } from './core/registry/permissions';
import { publicRoute } from './middlewares/access';
import { requestContext } from './middlewares/request-context';
import { tenantFromHost } from './middlewares/tenant';
import './modules/registry';
import { publicSchoolRoutes, schoolProfileRoutes } from './modules/school-profile';
import { authRoutes } from './modules/auth';
import { meRoutes, roleRoutes } from './modules/rbac/rbac.routes';
import { userRoutes } from './modules/users/users.routes';
import { settingsRoutes } from './modules/settings/settings.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { importRoutes } from './modules/imports/import.routes';
import { emailTemplateRoutes } from './modules/email-templates/email-templates.routes';
import { masterRoutes } from './modules/masters/masters.routes';
import { academicRoutes } from './modules/academic/academic.routes';
import { studentRoutes } from './modules/students/students.routes';
import { staffRoutes } from './modules/staff/staff.routes';
import { admissionRoutes, publicEnquiryRoutes } from './modules/admissions/admissions.routes';
import { feeRoutes } from './modules/fees/fees.routes';
import { paymentRoutes, publicPaymentRoutes } from './modules/payments/payments.routes';
import { myTimetableRoutes, substitutionRoutes, timetableRoutes } from './modules/timetable/timetable.routes';
import { documentRoutes } from './modules/documents/documents.routes';
import { reportRoutes } from './modules/reports/reports.routes';
import { attendanceRoutes } from './modules/attendance/attendance.routes';
import { admsRoutes, deviceRoutes, deviceWebhookRoutes } from './modules/attendance/devices.routes';

export const app = express();

// ─── Platform ────────────────────────────────────────────────────────────────
app.set('trust proxy', env.TRUST_PROXY);
// The frontend runs on another origin of the same site (localhost:3000 / erp.school.in vs the API on
// localhost:8000 / api.erp.school.in), so responses such as the logo may be used "same-site".
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

// Development default: localhost and LAN addresses on any port. Production: only CORS_ORIGINS.
const devOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/;
const allowedOrigins = env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];
const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        // Requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(null, !isProduction && allowedOrigins.length === 0 && devOrigin.test(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
};
app.use(cors(corsOptions));
// Keep the exact bytes too: payment gateways sign their webhooks over them.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => ((req as Request).rawBody = buf) }));
app.use(requestContext);

// ─── Health Check (no database, no school) ───────────────────────────────────
app.get('/health', publicRoute, (_req: Request, res: Response) => {
    res.json({ service: 'cms-backend', status: 'UP', timestamp: new Date().toISOString() });
});

// Attendance machines (eSSL / ZKTeco "ADMS"): they call <server>/iclock/… and are known by serial number.
app.use('/iclock', admsRoutes);

// Which school the calling page belongs to (before sign-in); the token decides after sign-in.
app.use('/api', tenantFromHost);

// ─── Modules (every route declares its own access rule) ──────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/public/school', publicSchoolRoutes);
app.use('/api/school-profile', schoolProfileRoutes);
app.use('/api/me', meRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/masters', masterRoutes);
app.use('/api/academic', academicRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/admissions', admissionRoutes);
app.use('/api/public/enquiry', publicEnquiryRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/public/payments', publicPaymentRoutes);
app.use('/api/timetable-subs', substitutionRoutes);
app.use('/api/my-timetable', myTimetableRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/attendance-devices', deviceRoutes);
app.use('/api/public/attendance-devices', deviceWebhookRoutes);
app.use('/api/attendance', attendanceRoutes);

app.use((req: Request, res: Response) => {
    errorResponse(res, `No route for ${req.method} ${req.path}`, 'NOT_FOUND', 404, undefined, getRequestId());
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use(globalErrorHandler);

// Refuse to start if any route lacks an access rule, or checks a permission nobody registered (a typo).
assertRoutesProtected(app);
const unknownPermissions = listRoutes(app)
    .filter((r) => r.access?.startsWith('can:') && !findPermissionDef(r.access.slice(4)))
    .map((r) => `  - ${r.method} ${r.path} checks "${r.access!.slice(4)}"`);
if (unknownPermissions.length) throw new Error(`Routes check permissions that are not registered:\n${unknownPermissions.join('\n')}`);
