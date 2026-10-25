import { Router, Request, Response } from 'express';
import * as yearClasses from './year-classes.service';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { sendFile } from '../../core/http/files';
import { buildWorkbook, XLSX_MIME } from '../../core/excel';
import { authenticated, can } from '../../middlewares/access';
import * as years from './years.service';
import * as classes from './classes.service';
import * as subjects from './subjects.service';
import { moveSchema } from '../../core/ordering';

const { parse } = years;
const view = can('academic.view');
const manage = can('academic.manage');
const move = moveSchema;
const yearQuery = z.object({ year: z.uuid('choose an academic year') });
const today = () => new Date().toISOString().slice(0, 10);

export const academicRoutes = Router();

// ─── Years ───────────────────────────────────────────────────────────────────

academicRoutes.get('/years', view, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await years.listYears(), 'Academic years')));
/** For dropdowns anywhere (every signed-in user). */
academicRoutes.get('/years/options', authenticated, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await years.yearOptions(), 'Academic years')));
academicRoutes.get('/years/suggest', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await years.suggestYear(), 'Suggested year')));
academicRoutes.post('/years', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await years.createYear(parse(years.yearInputSchema, req.body)), 'Academic year added', 201)));
academicRoutes.patch('/years/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await years.updateYear(req.params.id, parse(years.yearUpdateSchema, req.body)), 'Academic year saved')));
academicRoutes.post('/years/:id/current', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await years.setCurrentYear(req.params.id), 'Current year changed')));
academicRoutes.post('/years/:id/close', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await years.setYearStatus(req.params.id, 'closed'), 'Year closed')));
academicRoutes.post('/years/:id/reopen', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await years.setYearStatus(req.params.id, 'open'), 'Year reopened')));
academicRoutes.delete('/years/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await years.deleteYear(req.params.id), 'Academic year deleted')));
academicRoutes.post('/years/:id/copy', manage, asyncHandler(async (req: Request, res: Response) => {
    const body = parse(z.strictObject({ fromYearId: z.uuid('choose a year to copy from'), sections: z.boolean(), subjects: z.boolean() }), req.body);
    const result = await years.copyStructure(req.params.id, body.fromYearId, body);
    successResponse(res, result, `Copied ${result.sections} section(s) and ${result.subjects} class subject(s)`);
}));

// ─── Classes and sections ────────────────────────────────────────────────────

academicRoutes.get('/classes', view, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ year: z.uuid().optional() }), req.query);
    successResponse(res, await classes.listClasses(q.year), 'Classes');
}));
academicRoutes.get('/classes/options', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ year: z.uuid().optional(), all: z.enum(['1']).optional() }), req.query);
    successResponse(res, await classes.classOptions(q.year, q.all === '1'), 'Classes');
}));
// The classes a session runs (with admissions open and seats).
academicRoutes.get('/years/:id/classes', authenticated, asyncHandler(async (req: Request, res: Response) => successResponse(res, await yearClasses.yearClassesOverview(req.params.id), 'Classes of the session')));
academicRoutes.put('/years/:id/classes', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await yearClasses.setYearClasses(req.params.id, parse(yearClasses.yearClassesSchema, req.body)), 'Classes of the session saved')));
academicRoutes.post('/classes', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.createClass(parse(classes.classInputSchema, req.body)), 'Class added', 201)));
academicRoutes.patch('/classes/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.updateClass(req.params.id, parse(classes.classUpdateSchema, req.body)), 'Class saved')));
academicRoutes.delete('/classes/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.deleteClass(req.params.id), 'Class deleted')));
academicRoutes.post('/classes/:id/move', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.moveClass(req.params.id, parse(move, req.body)), 'Class moved')));

academicRoutes.get('/sections/options', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ year: z.uuid('choose an academic year'), class: z.uuid().optional() }), req.query);
    successResponse(res, await classes.sectionOptions(q.year, q.class), 'Sections');
}));
academicRoutes.get('/sections/export', view, asyncHandler(async (req: Request, res: Response) => {
    const { year } = parse(yearQuery, req.query);
    const y = await years.getYear(year);
    const rows = (await classes.listClasses(year)).flatMap((c) => c.sections.map((s) => ({ c, s })));
    const data = await buildWorkbook(`Sections ${y.name}`, [
        { header: 'Academic year', width: 14, value: () => y.name },
        { header: 'Class', width: 18, value: (r) => r.c.name },
        { header: 'Section', value: (r) => r.s.name },
        { header: 'Stream', value: (r) => r.s.stream?.name },
        { header: 'Capacity', value: (r) => r.s.capacity },
        { header: 'Room', value: (r) => r.s.room },
        { header: 'Class teacher (employee code)', width: 24, value: (r) => r.s.classTeacher?.code },
        { header: 'Class teacher', width: 24, value: (r) => r.s.classTeacher?.name },
        { header: 'Active', value: (r) => (r.s.isActive ? 'Yes' : 'No') },
    ], rows);
    sendFile(res, `sections-${y.name.replace(/[^\w-]+/g, '-')}-${today()}.xlsx`, XLSX_MIME, data);
}));
academicRoutes.post('/sections', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.createSection(parse(classes.sectionInputSchema, req.body)), 'Section added', 201)));
academicRoutes.patch('/sections/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.updateSection(req.params.id, parse(classes.sectionUpdateSchema, req.body)), 'Section saved')));
academicRoutes.delete('/sections/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.deleteSection(req.params.id), 'Section deleted')));
academicRoutes.post('/sections/:id/move', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await classes.moveSection(req.params.id, parse(move, req.body)), 'Section moved')));
/** Who can be chosen as class teacher. */
academicRoutes.get('/teachers/options', manage, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await classes.teacherOptions(), 'Teachers')));

// ─── Subjects ────────────────────────────────────────────────────────────────

academicRoutes.get('/subjects', view, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await subjects.listSubjects(), 'Subjects')));
academicRoutes.get('/subjects/options', authenticated, asyncHandler(async (_req: Request, res: Response) => successResponse(res, await subjects.subjectOptions(), 'Subjects')));
academicRoutes.get('/subjects/export', view, asyncHandler(async (_req: Request, res: Response) => {
    const rows = await subjects.listSubjects();
    const data = await buildWorkbook('Subjects', [
        { header: 'Name', width: 28, value: (s) => s.name },
        { header: 'Code', value: (s) => s.code },
        { header: 'Type', width: 20, value: (s) => s.type?.name },
        { header: 'Assessment', width: 16, value: (s) => (s.assessment === 'co_scholastic' ? 'Co-scholastic' : 'Scholastic') },
        { header: 'Active', value: (s) => (s.isActive ? 'Yes' : 'No') },
    ], rows);
    sendFile(res, `subjects-${today()}.xlsx`, XLSX_MIME, data);
}));
academicRoutes.post('/subjects', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subjects.createSubject(parse(subjects.subjectInputSchema, req.body)), 'Subject added', 201)));
academicRoutes.patch('/subjects/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subjects.updateSubject(req.params.id, parse(subjects.subjectUpdateSchema, req.body)), 'Subject saved')));
academicRoutes.delete('/subjects/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subjects.deleteSubject(req.params.id), 'Subject deleted')));
academicRoutes.post('/subjects/:id/move', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subjects.moveSubject(req.params.id, parse(move, req.body)), 'Subject moved')));

academicRoutes.get('/class-subjects', view, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ year: z.uuid('choose an academic year'), class: z.uuid('choose a class') }), req.query);
    successResponse(res, await subjects.getClassSubjects(q.year, q.class), 'Class subjects');
}));
academicRoutes.put('/class-subjects', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subjects.setClassSubjects(parse(subjects.classSubjectsSchema, req.body)), 'Subjects saved')));
