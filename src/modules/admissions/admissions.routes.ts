import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { sendFile } from '../../core/http/files';
import { getSetting } from '../../core/settings';
import { UPLOADS } from '../../core/files';
import { buildWorkbook, XLSX_MIME } from '../../core/excel';
import { can, publicRoute } from '../../middlewares/access';
import { createRateLimiter } from '../../middlewares/rate-limit';
import { getUserAccess } from '../rbac/access.service';
import * as enquiries from './enquiries.service';
import { enquiryListSpec } from './admissions.schemas';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

export const enquiryViewer = async (userId: string): Promise<enquiries.Viewer> => {
    const access = await getUserAccess(userId);
    return { userId, scope: access.permissions['enquiry.view'] ?? 'own' };
};
const viewer = (req: Request) => enquiryViewer(req.user!.userId);

export const admissionRoutes = Router();
const view = can('enquiry.view');
const manage = can('enquiry.manage');

admissionRoutes.get('/enquiries', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.listEnquiries(parseListQuery(req.query, enquiryListSpec), await viewer(req)), 'Enquiries')));
admissionRoutes.get('/enquiries/summary', view, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ year: z.uuid().optional() }), req.query);
    successResponse(res, await enquiries.enquirySummary(q.year, await viewer(req)), 'Enquiry summary');
}));
admissionRoutes.get('/enquiries/export', view, asyncHandler(async (req: Request, res: Response) => {
    const max = await getSetting(UPLOADS.maxExportRows);
    const q = parseListQuery({ ...req.query, page: '1', pageSize: String(Math.min(200, max)) }, enquiryListSpec);
    const rows = (await enquiries.listEnquiries(q, await viewer(req))).items;
    const data = await buildWorkbook('Enquiries', [
        { header: 'Enquiry no.', width: 18, value: (e) => e.enquiryNo },
        { header: 'Date', width: 12, value: (e) => e.enquiryDate },
        { header: 'Student', width: 26, value: (e) => e.studentName },
        { header: 'Class', value: (e) => e.class.name },
        { header: 'Parent', width: 24, value: (e) => e.parentName },
        { header: 'Mobile', width: 16, value: (e) => e.mobile },
        { header: 'Source', width: 18, value: (e) => e.source?.name },
        { header: 'Stage', width: 18, value: (e) => e.stage.name },
        { header: 'Follows up', width: 22, value: (e) => e.assignedTo?.name },
        { header: 'Next follow-up', width: 14, value: (e) => e.nextFollowUp },
        { header: 'Registration no.', width: 18, value: (e) => e.registrationNo },
    ], rows);
    sendFile(res, `enquiries-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));
admissionRoutes.get('/enquiries/form-config', view, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await enquiries.formConfig(), 'Enquiry form')));
// The report covers the enquiries the person may see.
admissionRoutes.get('/reports', can('enquiry.reports'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.enquiryReport(parse(enquiries.reportSchema, req.query), await viewer(req)), 'Admission report')));

admissionRoutes.post('/enquiries', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.createEnquiry(parse(enquiries.enquiryCreateSchema, req.body), await viewer(req)), 'Enquiry added', 201)));
admissionRoutes.get('/enquiries/:id', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.getEnquiry(req.params.id, await viewer(req)), 'Enquiry')));
admissionRoutes.patch('/enquiries/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.updateEnquiry(req.params.id, parse(enquiries.enquiryUpdateSchema, req.body), await viewer(req)), 'Saved')));
admissionRoutes.delete('/enquiries/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.deleteEnquiry(req.params.id, await viewer(req)), 'Enquiry deleted')));
admissionRoutes.post('/enquiries/:id/stage', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.setStage(req.params.id, parse(enquiries.stageSchema, req.body), await viewer(req)), 'Stage changed')));
admissionRoutes.post('/enquiries/:id/follow-ups', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.addFollowUp(req.params.id, parse(enquiries.followUpSchema, req.body), await viewer(req)), 'Follow-up saved', 201)));
admissionRoutes.delete('/enquiries/:id/follow-ups/:followUpId', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.deleteFollowUp(req.params.id, req.params.followUpId, await viewer(req)), 'Follow-up removed')));
admissionRoutes.post('/enquiries/:id/register', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.registerEnquiry(req.params.id, parse(enquiries.registerSchema, req.body), await viewer(req)), 'Registered')));
admissionRoutes.put('/enquiries/:id/test', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.setTest(req.params.id, parse(enquiries.testSchema, req.body), await viewer(req)), 'Test result saved')));
admissionRoutes.get('/enquiries/:id/admission', can('enquiry.convert'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.admissionPrefill(req.params.id, await viewer(req)), 'Admission form')));

/** The school website's enquiry form (no login; the school comes from the page's address). */
export const publicEnquiryRoutes = Router();
const enquiryLimiter = createRateLimiter({ windowInMinutes: 60, maxAttempts: 10, keyPrefix: 'public-enquiry' });

publicEnquiryRoutes.get('/', publicRoute, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await enquiries.publicFormInfo(), 'Enquiry form')));
publicEnquiryRoutes.post('/', publicRoute, enquiryLimiter, asyncHandler(async (req: Request, res: Response) => successResponse(res, await enquiries.submitPublicEnquiry(parse(enquiries.publicEnquirySchema, req.body)), 'Thank you, the school will call you', 201)));
