import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { runAsSystem } from '../../core/context';
import { db } from '../../core/db';
import { authenticated, can, publicRoute } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import { minutesIST, todayIST } from '../attendance/attendance.settings';
import { onQueuePass } from '../alerts/queue';
import { findTenantByCode, findTenantByHost } from '../tenants';
import { env } from '../../config/env';
import * as auth from './platform-auth';
import * as p from './platform.service';
import { goLive, setupProgress } from './onboarding';
import * as leads from './leads';
import { createRateLimiter } from '../../middlewares/rate-limit';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const me = (req: Request) => req.platformUser!.id;
const owner = auth.platformOnly(['owner']);
const staff = auth.platformOnly(['owner', 'support']);

// ─── The platform console (Klytos staff) ─────────────────────────────────────

export const platformRoutes = Router();

platformRoutes.post('/auth/login', publicRoute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await auth.login(parse(auth.loginSchema, req.body), req.ip), 'Enter your authenticator code')));
platformRoutes.post('/auth/verify', publicRoute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await auth.verify(parse(auth.verifySchema, req.body), req.ip), 'Signed in')));
platformRoutes.get('/auth/me', auth.platformOnly(['owner', 'support'], { allowPasswordChange: true }), asyncHandler(async (req: Request, res: Response) => successResponse(res, req.platformUser, 'Me')));
platformRoutes.post('/auth/password', auth.platformOnly(['owner', 'support'], { allowPasswordChange: true }), asyncHandler(async (req: Request, res: Response) => successResponse(res, await auth.changePassword(me(req), parse(auth.passwordSchema, req.body)), 'Password changed')));

// Schools.
platformRoutes.get('/schools', staff, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await p.listSchools(), 'Schools')));
platformRoutes.post('/schools', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.createSchool(parse(p.createSchoolSchema, req.body), me(req), req.ip), 'School added', 201)));
platformRoutes.get('/schools/:id', staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.getSchool(req.params.id), 'School')));
platformRoutes.put('/schools/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.updateSchool(req.params.id, parse(p.updateSchoolSchema, req.body), me(req), req.ip), 'Saved')));
platformRoutes.post('/schools/:id/code', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.changeCode(req.params.id, parse(p.changeCodeSchema, req.body), me(req), req.ip), 'Code changed')));
platformRoutes.delete('/schools/:id/old-codes/:code', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.removeOldCode(req.params.id, req.params.code, me(req), req.ip), 'Old code removed')));
platformRoutes.post('/schools/:id/status', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.setStatus(req.params.id, parse(p.statusSchema, req.body), me(req), req.ip), 'Saved')));
platformRoutes.post('/schools/:id/admins/:userId/reset', staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.resetAdminPassword(req.params.id, req.params.userId, me(req), req.ip), 'New one-time password')));
platformRoutes.put('/schools/:id/mail', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.setMail(req.params.id, parse(p.mailSchema, req.body), me(req), req.ip), 'Saved')));
platformRoutes.post('/schools/:id/delete', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.requestDelete(req.params.id, parse(p.deleteRequestSchema, req.body), me(req), req.ip), 'Deletion scheduled')));
platformRoutes.post('/schools/:id/delete/cancel', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.cancelDelete(req.params.id, me(req), req.ip), 'Deletion cancelled')));
platformRoutes.get('/schools/:id/export', owner, asyncHandler(async (req: Request, res: Response) => {
    const { filename, data } = await p.exportSchool(req.params.id, me(req), req.ip);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data);
}));

// Demo requests from the website.
platformRoutes.get('/leads', staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await leads.listLeads(parse(leads.leadsQuery, req.query)), 'Leads')));
platformRoutes.put('/leads/:id', staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await leads.updateLead(req.params.id, parse(leads.leadUpdateSchema, req.body), me(req), req.ip), 'Saved')));

// Menu templates.
platformRoutes.get('/menu-templates', staff, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await p.listMenuTemplates(), 'Templates')));
platformRoutes.post('/schools/:id/menu-template', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.templateFromSchool(req.params.id, parse(p.templateFromSchoolSchema, req.body), me(req), req.ip), 'Template saved')));
platformRoutes.post('/schools/:id/menu', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.applyMenuTemplate(req.params.id, parse(z.object({ templateId: z.uuid().nullable() }), req.body).templateId, me(req), req.ip), 'Menu applied')));
platformRoutes.delete('/menu-templates/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.deleteMenuTemplate(req.params.id, me(req), req.ip), 'Template deleted')));

// Plans.
platformRoutes.get('/plans', staff, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await p.listPlans(), 'Plans')));
platformRoutes.post('/plans', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.savePlan(null, parse(p.planSchema, req.body), me(req), req.ip), 'Plan added', 201)));
platformRoutes.put('/plans/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.savePlan(req.params.id, parse(p.planSchema, req.body), me(req), req.ip), 'Plan saved')));
platformRoutes.post('/plans/:id/apply', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.applyPlanToSchools(req.params.id, me(req), req.ip), 'Applied')));
platformRoutes.delete('/plans/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.deletePlan(req.params.id, me(req), req.ip), 'Plan deleted')));

// Platform staff, the log, notices to schools.
platformRoutes.get('/staff', owner, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await p.listStaff(), 'Staff')));
platformRoutes.post('/staff', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.saveStaff(null, parse(p.staffSchema, req.body), me(req), req.ip), 'Added', 201)));
platformRoutes.put('/staff/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.saveStaff(req.params.id, parse(p.staffSchema, req.body), me(req), req.ip), 'Saved')));
platformRoutes.post('/staff/:id/reset', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.resetStaff(req.params.id, me(req), req.ip), 'Reset')));
platformRoutes.get('/log', staff, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.listLog(parse(p.logQuery, req.query)), 'Log')));
platformRoutes.get('/notices', staff, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await p.listNotices(), 'Notices')));
platformRoutes.post('/notices', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.saveNotice(null, parse(p.noticeSchema, req.body), me(req), req.ip), 'Saved', 201)));
platformRoutes.put('/notices/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.saveNotice(req.params.id, parse(p.noticeSchema, req.body), me(req), req.ip), 'Saved')));
platformRoutes.delete('/notices/:id', owner, asyncHandler(async (req: Request, res: Response) => successResponse(res, await p.deleteNotice(req.params.id, me(req), req.ip), 'Deleted')));

// ─── For the schools ─────────────────────────────────────────────────────────

export const platformInfoRoutes = Router();

/** The website's "Book a demo" form (five a visitor an hour). */
platformInfoRoutes.post('/lead', publicRoute, createRateLimiter({ windowInMinutes: 60, maxAttempts: 5, keyPrefix: 'lead' }), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leads.addLead(parse(leads.leadSchema, req.body), req.ip), 'Thank you', 201)));
/** The login page on a shared address: does this school code exist (its name, to confirm). */
platformInfoRoutes.get('/school', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const code = parse(z.object({ code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'is not a school code') }), req.query).code;
    const t = await findTenantByCode(code);
    const name = t?.status === 'active' ? (await runAsSystem(() => db.tenant.findUnique({ where: { id: t.id }, select: { name: true } })))?.name : null;
    successResponse(res, { found: !!name, code, name: name ?? null }, name ? 'School found' : 'No school with that code');
}));
/**
 * Caddy asks before getting an HTTPS certificate for an address: yes for a school's own domain, a
 * school's <code>.<PLATFORM_DOMAIN>, and the platform's own addresses; no for anything else.
 */
platformInfoRoutes.get('/tls-check', publicRoute, asyncHandler(async (req: Request, res: Response) => {
    const host = String(req.query.domain ?? '').trim().toLowerCase();
    const base = env.PLATFORM_DOMAIN?.trim().toLowerCase();
    const own = base && [base, `www.${base}`, `app.${base}`, `console.${base}`].includes(host);
    const school = !own && /^[a-z0-9.-]{3,253}$/.test(host) ? await findTenantByHost(host, base) : null;
    res.status(own || school ? 200 : 404).send(own || school ? 'ok' : 'unknown');
}));
/** Banners and "What's new" from Klytos (admins and principals also get the ones meant for them). */
platformInfoRoutes.get('/notices', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const a = await getUserAccess(req.user!.userId);
    successResponse(res, await p.noticesFor(a.isSuperAdmin || a.roles.some((r) => r.slug === 'school-admin' || r.slug === 'principal')), 'Notices');
}));
platformInfoRoutes.get('/setup', can('school_profile.update'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await setupProgress(), 'Setup')));
platformInfoRoutes.post('/setup/live', can('school_profile.update'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await goLive(req.user!.userId), 'Your school is live')));

// Once a day (after 3 am): schools whose deletion date has passed are removed.
let purgedOn = '';
onQueuePass(async () => {
    const today = todayIST();
    if (purgedOn === today || minutesIST() < 180) return;
    purgedOn = today;
    await p.purgeDueSchools();
});
