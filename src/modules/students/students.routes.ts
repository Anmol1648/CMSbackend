import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { parseListQuery } from '../../core/http/list-query';
import { sendFile, upload } from '../../core/http/files';
import { getSetting } from '../../core/settings';
import { UPLOADS } from '../../core/files';
import { buildWorkbook, XLSX_MIME } from '../../core/excel';
import { can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as students from './students.service';
import * as family from './family.service';
import * as files from './student-files.service';
import { enrolmentSchema, placeStudent, renumberSection } from './enrolment.service';
import { studentListSpec } from './students.schemas';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};

/** Whom the signed-in person may see (scope of student.view) and whether sensitive fields are shown. */
const viewer = async (req: Request): Promise<students.Viewer> => {
    const access = await getUserAccess(req.user!.userId);
    return { userId: req.user!.userId, scope: access.permissions['student.view'] ?? 'all', sensitive: !!access.permissions['student.view_sensitive'] };
};

export const studentRoutes = Router();

const view = can('student.view');
const update = can('student.update');

studentRoutes.get('/', view, asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await students.listStudents(parseListQuery(req.query, studentListSpec), await viewer(req)), 'Students');
}));

studentRoutes.get('/export', view, asyncHandler(async (req: Request, res: Response) => {
    const max = await getSetting(UPLOADS.maxExportRows);
    const q = parseListQuery({ ...req.query, page: '1', pageSize: '200' }, studentListSpec);
    const rows: Awaited<ReturnType<typeof students.listStudents>>['items'] = [];
    // The list is paged; read every page (up to the export limit).
    for (let page = 1; rows.length < max; page++) {
        const r = await students.listStudents({ ...q, page, skip: (page - 1) * 200, take: 200 }, await viewer(req));
        rows.push(...r.items);
        if (r.items.length < 200) break;
    }
    const data = await buildWorkbook('Students', [
        { header: 'Admission no', width: 16, value: (s) => s.admissionNo },
        { header: 'Name', width: 28, value: (s) => s.name },
        { header: 'Class', width: 16, value: (s) => s.section.label },
        { header: 'Roll no', value: (s) => s.rollNumber },
        { header: 'Gender', value: (s) => s.gender?.name },
        { header: 'Date of birth', width: 14, value: (s) => s.dateOfBirth },
        { header: 'House', value: (s) => s.house?.name },
        { header: 'Parent / guardian', width: 24, value: (s) => s.contact?.name },
        { header: 'Mobile', width: 16, value: (s) => s.contact?.mobile },
        { header: 'Status', value: (s) => s.status },
    ], rows.slice(0, max));
    sendFile(res, `students-${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME, data);
}));

studentRoutes.get('/form-config', view, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await students.formConfig(), 'Admission form')));
studentRoutes.get('/next-admission-number', can('student.create'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ section: z.uuid().optional() }), req.query);
    successResponse(res, await students.previewAdmissionNumber(q.section), 'Next admission number');
}));
studentRoutes.get('/families', can('student.create'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ q: z.string().max(80) }), req.query);
    successResponse(res, await family.searchFamilies(q.q), 'Families');
}));

studentRoutes.post('/', can('student.create'), asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await students.admitStudent(parse(students.admissionSchema, req.body), await viewer(req)), 'Student admitted', 201);
}));

studentRoutes.post('/sections/:sectionId/renumber', update, asyncHandler(async (req: Request, res: Response) => {
    const r = await renumberSection(req.params.sectionId);
    successResponse(res, r, `Roll numbers of ${r.section} renumbered (${r.students} students)`);
}));

studentRoutes.get('/:id', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Student')));
studentRoutes.patch('/:id', update, asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await students.updateStudent(req.params.id, parse(students.studentUpdateSchema, req.body), await viewer(req)), 'Student saved');
}));
studentRoutes.post('/:id/status', update, asyncHandler(async (req: Request, res: Response) => {
    successResponse(res, await students.setStatus(req.params.id, parse(students.statusSchema, req.body), await viewer(req)), 'Status changed');
}));
studentRoutes.put('/:id/enrolment', update, asyncHandler(async (req: Request, res: Response) => {
    const r = await placeStudent(req.params.id, parse(enrolmentSchema, req.body));
    successResponse(res, { ...r, student: await students.getStudent(req.params.id, await viewer(req)) }, r.warning ? `Saved. ${r.warning}` : 'Section saved');
}));
studentRoutes.post('/:id/login', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.addStudentLogin(req.params.id, await viewer(req)), 'Login created')));

// Family
studentRoutes.post('/:id/guardians', update, asyncHandler(async (req: Request, res: Response) => {
    await family.addGuardian(req.params.id, parse(family.guardianSchema, req.body));
    successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Parent / guardian added', 201);
}));
studentRoutes.patch('/:id/guardians/:guardianId', update, asyncHandler(async (req: Request, res: Response) => {
    await family.updateGuardian(req.params.guardianId, parse(family.guardianSchema.partial(), req.body));
    successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Parent / guardian saved');
}));
studentRoutes.delete('/:id/guardians/:guardianId', update, asyncHandler(async (req: Request, res: Response) => {
    await family.removeGuardian(req.params.guardianId);
    successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Parent / guardian removed');
}));
studentRoutes.post('/:id/guardians/:guardianId/login', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await family.addParentLogin(req.params.guardianId), 'Parent login created')));
studentRoutes.post('/:id/family', update, asyncHandler(async (req: Request, res: Response) => {
    await family.linkFamily(req.params.id, parse(z.strictObject({ familyId: z.uuid() }), req.body).familyId);
    successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Linked to the sibling’s family');
}));

// Photo and documents
studentRoutes.get('/:id/photo', view, asyncHandler(async (req: Request, res: Response) => {
    await students.getStudent(req.params.id, await viewer(req)); // only students the viewer may see
    const { file, data } = await files.readPhoto(req.params.id);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true, cacheSeconds: 86_400 });
}));
studentRoutes.post('/:id/photo', update, upload.single('image'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a photo (PNG, JPG or WebP)');
    successResponse(res, await files.setPhoto(req.params.id, { data: req.file.buffer, originalName: req.file.originalname }), 'Photo saved');
}));
studentRoutes.delete('/:id/photo', update, asyncHandler(async (req: Request, res: Response) => successResponse(res, await files.removePhoto(req.params.id), 'Photo removed')));
studentRoutes.post('/:id/documents', update, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose the file (PDF, PNG or JPG)');
    await files.addDocument(req.params.id, { data: req.file.buffer, originalName: req.file.originalname }, parse(files.documentSchema, req.body));
    successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Document added', 201);
}));
studentRoutes.get('/:id/documents/:documentId', view, asyncHandler(async (req: Request, res: Response) => {
    await students.getStudent(req.params.id, await viewer(req));
    const { file, data } = await files.readDocument(req.params.id, req.params.documentId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
studentRoutes.delete('/:id/documents/:documentId', update, asyncHandler(async (req: Request, res: Response) => {
    await files.removeDocument(req.params.id, req.params.documentId);
    successResponse(res, await students.getStudent(req.params.id, await viewer(req)), 'Document removed');
}));
