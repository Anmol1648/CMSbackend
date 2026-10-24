import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { db } from '../../core/db';
import { XLSX_MIME } from '../../core/excel';
import { getUserAccess } from '../rbac/access.service';
import { fullName } from '../students/students.service';
import * as hall from './hall.service';
import * as papers from './papers.service';
import * as entry from './entry2.service';
import * as after from './after.service';
import * as analysis from './analysis.service';
import { submitSheet, unlockSheet } from './marks.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
const needAny = (keys: string[]) =>
    asyncHandler(async (req: Request, _res: Response, next: () => void) => {
        const a = await getUserAccess(uid(req));
        if (!keys.some((k) => a.permissions[k])) throw forbidden();
        next();
    });
const ENTERERS = ['exam.marks', 'exam.marks_any', 'exam.moderate'];
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const session = z.object({ date: D, time: z.string().max(10).default('') });
const sheet = z.object({ examSubjectId: z.uuid(), section: z.uuid() });

export const exam2Routes = Router();

// The exam hall: seating, invigilation, admit cards.
exam2Routes.get('/rooms', authenticated, needAny(['exam.seating', 'exam.admit']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await hall.rooms(), 'Rooms')));
exam2Routes.get('/teachers', can('exam.seating'), asyncHandler(async (_req: Request, res: Response) => {
    const ids = [...new Set((await db.teachingAssignment.findMany({ select: { staffId: true } })).map((t) => t.staffId))];
    const rows = await db.staff.findMany({ where: { status: 'working', id: { in: ids } }, orderBy: { firstName: 'asc' }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } });
    successResponse(res, rows.map((r) => ({ id: r.id, name: `${fullName(r)} (${r.employeeCode})` })), 'Teachers');
}));
exam2Routes.get('/duties/mine', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await hall.myDuties(uid(req)), 'My duties')));
exam2Routes.get('/hall/:examId/sessions', authenticated, needAny(['exam.seating', 'exam.admit']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hall.sessions(req.params.examId), 'Papers')));
exam2Routes.post('/hall/:examId/seating', can('exam.seating'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hall.makeSeating(req.params.examId, parse(hall.seatSchema, req.body), uid(req)), 'Seated')));
exam2Routes.get('/hall/:examId/seating', authenticated, needAny(['exam.seating', 'exam.admit']), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(session, req.query);
    successResponse(res, await hall.seating(req.params.examId, q.date, q.time), 'Seating');
}));
exam2Routes.delete('/hall/:examId/seating', can('exam.seating'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(session, req.query);
    successResponse(res, await hall.clearSeating(req.params.examId, q.date, q.time), 'Cleared');
}));
exam2Routes.post('/hall/:examId/duties/auto', can('exam.seating'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ date: D, startTime: z.string().max(10).default('') }), req.body);
    await hall.makeDuties(req.params.examId, q.date, q.startTime);
    successResponse(res, await hall.seating(req.params.examId, q.date, q.startTime), 'Duties made');
}));
exam2Routes.put('/hall/:examId/duties', can('exam.seating'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hall.setDuty(req.params.examId, parse(hall.dutySchema, req.body)), 'Saved')));
exam2Routes.get('/hall/:examId/admit', can('exam.admit'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await hall.admitList(req.params.examId, parse(z.object({ section: z.uuid() }), req.query).section), 'Admit cards')));
exam2Routes.post('/hall/:examId/admit/release', can('exam.admit'), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ studentId: z.uuid(), release: z.boolean() }), req.body);
    successResponse(res, await hall.releaseAdmit(req.params.examId, b.studentId, b.release, uid(req)), 'Saved');
}));

// Question papers.
exam2Routes.post('/papers/file', authenticated, needAny(['exam.papers', 'exam.marks']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['pdf', 'docx', 'jpeg', 'png'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
exam2Routes.get('/papers/:examId', authenticated, needAny(['exam.papers', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await papers.paperList(req.params.examId, uid(req)), 'Papers')));
exam2Routes.get('/papers/:examId/:classId/:subjectId', authenticated, needAny(['exam.papers', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await papers.getPaper(req.params.examId, req.params.classId, req.params.subjectId, uid(req)), 'Paper')));
exam2Routes.put('/papers/:examId/:classId/:subjectId', authenticated, needAny(['exam.papers', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await papers.savePaper(req.params.examId, req.params.classId, req.params.subjectId, parse(papers.paperSchema, req.body), uid(req)), 'Saved')));
exam2Routes.get('/papers/:examId/:classId/:subjectId/bank', authenticated, needAny(['exam.papers', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await papers.bank(req.params.examId, req.params.classId, req.params.subjectId, parse(papers.bankQuery, req.query), uid(req)), 'Questions')));
exam2Routes.post('/papers/:examId/:classId/:subjectId/auto', authenticated, needAny(['exam.papers', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await papers.autoFill(req.params.examId, req.params.classId, req.params.subjectId, parse(papers.autoSchema, req.body), uid(req)), 'Filled')));
exam2Routes.get('/papers/:examId/:classId/:subjectId/file', authenticated, needAny(['exam.papers', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => {
    const p = await papers.getPaper(req.params.examId, req.params.classId, req.params.subjectId, uid(req));
    if (!p.fileId) throw badRequest('No file uploaded');
    const { file, data } = await readFile(p.fileId);
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));

// Marks entry: Excel, submit / unlock, health, remarks.
exam2Routes.get('/sheet/excel', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(sheet, req.query);
    const f = await entry.sheetExcel(q.examSubjectId, q.section, uid(req));
    sendFile(res, f.filename, XLSX_MIME, f.buffer);
}));
exam2Routes.post('/sheet/excel', authenticated, needAny(ENTERERS), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(sheet, req.query);
    if (!req.file) throw badRequest('Choose the Excel file');
    successResponse(res, await entry.readSheetExcel(q.examSubjectId, q.section, req.file.buffer, uid(req)), 'Read');
}));
exam2Routes.post('/sheet/submit', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ examSubjectId: z.uuid(), sectionId: z.uuid() }), req.body);
    successResponse(res, await submitSheet(b.examSubjectId, b.sectionId, uid(req)), 'Submitted');
}));
exam2Routes.post('/sheet/unlock', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ examSubjectId: z.uuid(), sectionId: z.uuid() }), req.body);
    successResponse(res, await unlockSheet(b.examSubjectId, b.sectionId, uid(req)), 'Unlocked');
}));
exam2Routes.get('/health', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ section: z.uuid(), term: z.string().max(40).default('year') }), req.query);
    successResponse(res, await entry.getHealth(q.section, q.term, uid(req)), 'Health');
}));
exam2Routes.put('/health', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await entry.saveHealth(parse(z.object({ section: z.uuid() }), req.query).section, parse(entry.healthSchema, req.body), uid(req)), 'Saved')));
exam2Routes.get('/remarks', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await entry.bankRemarks(parse(z.object({ percent: z.coerce.number().optional() }), req.query).percent ?? null), 'Remarks')));
exam2Routes.post('/remarks/ai', authenticated, needAny(ENTERERS), asyncHandler(async (req: Request, res: Response) => {
    const b = parse(z.object({ scope: z.enum(['exam', 'term', 'final']), id: z.uuid(), section: z.uuid(), student: z.uuid() }), req.body);
    successResponse(res, await entry.aiRemark(b.scope, b.id, b.section, b.student, uid(req)), 'Suggested');
}));

// After the result: supplementary, re-checks.
exam2Routes.get('/supplementary', can('exam.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.supplementaryCandidates(parse(z.object({ year: z.uuid() }), req.query).year), 'Candidates')));
exam2Routes.post('/supplementary', can('exam.setup'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.createSupplementary(parse(z.object({ year: z.uuid() }), req.query).year, parse(after.supplementarySchema, req.body), uid(req)), 'Created', 201)));
exam2Routes.get('/rechecks/options', can('exam.mine'), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ exam: z.uuid(), student: z.uuid() }), req.query);
    successResponse(res, await after.recheckOptions(q.exam, q.student, uid(req)), 'Options');
}));
exam2Routes.post('/rechecks', can('exam.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.askRecheck(parse(after.recheckSchema, req.body), uid(req)), 'Asked', 201)));
exam2Routes.get('/rechecks/mine', can('exam.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.myRechecks(uid(req)), 'My re-checks')));
exam2Routes.get('/rechecks', authenticated, needAny(['exam.recheck', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.listRechecks(parse(z.object({ show: z.enum(['open', 'done', 'all']).default('open') }), req.query).show, uid(req)), 'Re-checks')));
exam2Routes.post('/rechecks/:id/review', authenticated, needAny(['exam.recheck', 'exam.marks']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.reviewRecheck(req.params.id, parse(after.reviewSchema, req.body), uid(req)), 'Reviewed')));
exam2Routes.post('/rechecks/:id/decide', can('exam.recheck'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await after.decideRecheck(req.params.id, parse(z.object({ approve: z.boolean() }), req.body).approve, uid(req)), 'Decided')));

// Analysis.
exam2Routes.get('/analysis', authenticated, needAny(['exam.analysis', 'exam.view']), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ scope: z.enum(['exam', 'term', 'final']), id: z.uuid(), class: z.uuid().optional() }), req.query);
    successResponse(res, await analysis.schoolAnalysis(q.scope, q.id, q.class, uid(req)), 'Analysis');
}));
exam2Routes.get('/progress/:studentId', can('exam.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await analysis.myProgress(req.params.studentId, uid(req)), 'Progress')));
