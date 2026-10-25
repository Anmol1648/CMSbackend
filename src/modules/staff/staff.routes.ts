import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { sendFile, upload } from '../../core/http/files';
import { getSetting } from '../../core/settings';
import { UPLOADS } from '../../core/files';
import { buildWorkbook, XLSX_MIME } from '../../core/excel';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as staff from './staff.service';
import * as files from './staff-files.service';
import * as teaching from './teaching.service';
import { staffListSpec } from './staff.schemas';
import { exportExtras } from '../forms/forms.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

const viewer = async (req: Request): Promise<staff.Viewer> => {
    const access = await getUserAccess(req.user!.userId);
    return { userId: req.user!.userId, scope: access.permissions['staff.view'] ?? 'all', sensitive: !!access.permissions['staff.view_sensitive'] };
};

export const staffRoutes = Router();
const view = can('staff.view');
const update = can('staff.update');
const assign = can('teaching.assign');

staffRoutes.get('/', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.listStaff(parseListQuery(req.query, staffListSpec), await viewer(req)), 'Staff')));
staffRoutes.get('/export', view, asyncHandler(async (req: Request, res: Response) => {
    const max = await getSetting(UPLOADS.maxExportRows);
    const q = parseListQuery({ ...req.query, page: '1', pageSize: String(Math.min(200, max)) }, staffListSpec);
    const rows = (await staff.listStaff(q, await viewer(req))).items;
    const extra = await exportExtras('staff', rows.map((s) => s.id), req.user!.userId);
    const L = (key: string, label: string) => extra.labels[key] ?? label;
    const data = await buildWorkbook('Staff', [
        { header: L('employeeCode', 'Employee code'), width: 16, value: (s) => s.employeeCode },
        { header: 'Name', width: 28, value: (s) => s.name },
        { header: L('departmentId', 'Department'), width: 20, value: (s) => s.department?.name },
        { header: L('designationId', 'Designation'), width: 22, value: (s) => s.designation?.name },
        { header: 'Staff type', value: (s) => s.staffType?.name },
        { header: L('mobile', 'Mobile'), width: 16, value: (s) => s.mobile },
        { header: 'Can sign in', value: (s) => (s.canSignIn ? 'Yes' : 'No') },
        { header: 'Status', value: (s) => s.status },
        ...extra.columns,
    ], rows);
    sendFile(res, `staff-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));
staffRoutes.get('/form-config', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.formConfig(req.user!.userId), 'Staff form')));
staffRoutes.get('/next-code', can('staff.create'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await staff.previewEmployeeCode(), 'Next employee code')));
/** Working staff for dropdowns (class teacher, subject teacher, reports to). */
staffRoutes.get('/options', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ teaching: z.enum(['1', '0']).optional() }), req.query);
    successResponse(res, await staff.staffOptions({ teaching: q.teaching === '1' }), 'Staff');
}));

// My own record and classes (any signed-in staff member)
staffRoutes.get('/me', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.myStaff(req.user!.userId), 'My staff record')));
staffRoutes.patch('/me', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const body = parse(staff.staffUpdateSchema.extend({ qualifications: staff.qualificationsSchema.optional(), experience: staff.experienceSchema.optional() }), req.body);
    successResponse(res, await staff.updateMyStaff(req.user!.userId, body), 'Saved');
}));
staffRoutes.get('/me/teaching', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await teaching.myTeaching(req.user!.userId), 'My classes')));

// Subject teachers
staffRoutes.get('/teaching/grid', assign, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ year: z.uuid('choose an academic year'), class: z.uuid('choose a class') }), req.query);
    successResponse(res, await teaching.assignmentGrid(q.year, q.class), 'Subject teachers');
}));
staffRoutes.put('/teaching', assign, asyncHandler(async (req: Request, res: Response) => successResponse(res, await teaching.setAssignment(parse(teaching.assignSchema, req.body)), 'Saved')));
staffRoutes.post('/teaching/copy', assign, asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.strictObject({ toYearId: z.uuid(), fromYearId: z.uuid() }), req.body);
    const r = await teaching.copyAssignments(b.toYearId, b.fromYearId);
    successResponse(res, r, `Copied ${r.copied} subject teacher(s)`);
}));

staffRoutes.post('/', can('staff.create'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.createStaff(parse(staff.createStaffSchema, req.body), await viewer(req)), 'Staff member added', 201)));
staffRoutes.get('/:id', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.getStaff(req.params.id, await viewer(req)), 'Staff member')));
staffRoutes.patch('/:id', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.updateStaff(req.params.id, parse(staff.staffUpdateSchema, req.body), await viewer(req)), 'Saved')));
staffRoutes.put('/:id/qualifications', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.setQualifications(req.params.id, parse(staff.qualificationsSchema, req.body), await viewer(req)), 'Qualifications saved')));
staffRoutes.put('/:id/experience', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.setExperience(req.params.id, parse(staff.experienceSchema, req.body), await viewer(req)), 'Experience saved')));
staffRoutes.post('/:id/status', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.setStatus(req.params.id, parse(staff.statusSchema, req.body), await viewer(req)), 'Status saved')));
staffRoutes.post('/:id/login', update, asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.strictObject({ roleIds: z.array(z.uuid()).max(10).optional() }), req.body);
    successResponse(res, await staff.addStaffLogin(req.params.id, b.roleIds, await viewer(req)), 'Login created');
}));

staffRoutes.get('/:id/photo', view, asyncHandler(async (req: Request, res: Response) => {
    await staff.getStaff(req.params.id, await viewer(req));
    const { file, data } = await files.readPhoto(req.params.id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
}));
staffRoutes.post('/:id/photo', update, upload.single('image'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a photo (PNG, JPG or WebP)');
    successResponse(res, await files.setPhoto(req.params.id, { data: req.file.buffer, originalName: req.file.originalname }), 'Photo saved');
}));
staffRoutes.delete('/:id/photo', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await files.removePhoto(req.params.id), 'Photo removed')));
staffRoutes.post('/:id/documents', update, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose the file (PDF, PNG or JPG)');
    await files.addDocument(req.params.id, { data: req.file.buffer, originalName: req.file.originalname }, parse(files.documentSchema, req.body));
    successResponse(res, await staff.getStaff(req.params.id, await viewer(req)), 'Document added', 201);
}));
staffRoutes.get('/:id/documents/:documentId', view, asyncHandler(async (req: Request, res: Response) => {
    await staff.getStaff(req.params.id, await viewer(req));
    const { file, data } = await files.readDocument(req.params.id, req.params.documentId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
staffRoutes.delete('/:id/documents/:documentId', update, asyncHandler(async (req: Request, res: Response) => {
    await files.removeDocument(req.params.id, req.params.documentId);
    successResponse(res, await staff.getStaff(req.params.id, await viewer(req)), 'Document removed');
}));
