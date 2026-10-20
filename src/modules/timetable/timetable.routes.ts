import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { db } from '../../core/db';
import { can } from '../../middlewares/access';
import * as setup from './tt-setup.service';
import * as tt from './timetable.service';
import * as subs from './substitutions.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const yearQuery = z.object({ year: z.uuid('choose an academic year') });
const year = (req: Request) => parse(yearQuery, req.query).year;

export const timetableRoutes = Router();
const view = can('timetable.view');
const manage = can('timetable.manage');
const substitute = can('timetable.substitute');

// ─── Set-up ──────────────────────────────────────────────────────────────────
timetableRoutes.post('/setup/start', manage, asyncHandler(async (req: Request, res: Response) => {
    const r = await setup.startYear(year(req));
    successResponse(res, r, r.schedules || r.loads ? 'Set up with the defaults' : 'Already set up');
}));
timetableRoutes.get('/setup/schedules', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listSchedules(year(req)), 'Bell schedules')));
timetableRoutes.post('/setup/schedules', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.createSchedule(year(req), parse(setup.scheduleSchema, req.body)), 'Schedule added', 201)));
timetableRoutes.put('/setup/schedules/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.updateSchedule(req.params.id, parse(setup.scheduleSchema, req.body)), 'Schedule saved')));
timetableRoutes.delete('/setup/schedules/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.deleteSchedule(req.params.id), 'Schedule removed')));
timetableRoutes.get('/setup/days', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listDays(year(req)), 'School days')));
timetableRoutes.put('/setup/days', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveDays(year(req), parse(setup.daysSchema, req.body)), 'School days saved')));
timetableRoutes.get('/setup/week', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.weekOf(year(req)), 'Week')));
timetableRoutes.get('/setup/loads', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.loadOverview(year(req)), 'Periods per class')));
timetableRoutes.get('/setup/loads/:classId', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.listLoads(year(req), req.params.classId), 'Periods')));
timetableRoutes.put('/setup/loads/:classId', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveLoads(year(req), req.params.classId, parse(setup.loadsSchema, req.body)), 'Periods saved')));
timetableRoutes.get('/setup/teachers', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.teacherLoads(year(req)), 'Teachers')));
timetableRoutes.put('/setup/teachers/:staffId', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await setup.saveTeacherRule(year(req), req.params.staffId, parse(setup.teacherRuleSchema, req.body)), 'Saved')));

// ─── Timetables ──────────────────────────────────────────────────────────────
timetableRoutes.get('/', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.listTimetables(year(req)), 'Timetables')));
timetableRoutes.post('/generate', manage, asyncHandler(async (req: Request, res: Response) => {
    const r = await tt.generate(year(req), parse(tt.generateSchema, req.body));
    successResponse(res, r, `Placed ${r.placed} of ${r.wanted} periods`, 201);
}));
timetableRoutes.get('/:id', view, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.timetableOverview(req.params.id), 'Timetable')));
timetableRoutes.get('/:id/grid', view, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ section: z.uuid().optional(), teacher: z.uuid().optional() }), req.query);
    if (!q.section && !q.teacher) throw badRequest('Choose a section or a teacher');
    successResponse(res, await tt.grid(req.params.id, { sectionId: q.section, staffId: q.teacher }), 'Timetable');
}));
timetableRoutes.get('/:id/free', view, asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ weekday: z.coerce.number().int().min(1).max(7), period: z.coerce.number().int().min(1).max(20) }), req.query);
    successResponse(res, await tt.freeTeachers(req.params.id, q.weekday, q.period), 'Free teachers');
}));
timetableRoutes.put('/:id/cell', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.setCell(req.params.id, parse(tt.cellSchema, req.body)), 'Saved')));
timetableRoutes.post('/:id/swap', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.swapCells(req.params.id, parse(tt.swapSchema, req.body)), 'Swapped')));
timetableRoutes.patch('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.renameTimetable(req.params.id, parse(tt.renameSchema, req.body)), 'Saved')));
timetableRoutes.post('/:id/publish', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.publish(req.params.id), 'Published: everyone sees this timetable now')));
timetableRoutes.post('/:id/copy', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.copyTimetable(req.params.id), 'Copied into a new draft', 201)));
timetableRoutes.delete('/:id', manage, asyncHandler(async (req: Request, res: Response) => successResponse(res, await tt.deleteTimetable(req.params.id), 'Timetable deleted')));

/** Separate router: /api/timetable-subs and /api/my-timetable don't clash with /:id above. */
export const substitutionRoutes = Router();
substitutionRoutes.get('/', substitute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subs.substitutionDay(parse(z.object({ date: z.iso.date() }), req.query).date), 'Substitutions')));
substitutionRoutes.post('/absent', substitute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subs.markAbsent(parse(subs.absentSchema, req.body)), 'Marked absent', 201)));
substitutionRoutes.post('/absent/clear', substitute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subs.clearAbsent(parse(subs.absentSchema, req.body)), 'Removed')));
substitutionRoutes.put('/:id', substitute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subs.assignSubstitute(req.params.id, parse(subs.assignSchema, req.body)), 'Saved')));
substitutionRoutes.get('/report', substitute, asyncHandler(async (req: Request, res: Response) => successResponse(res, await subs.substitutionReport(parse(z.object({ month: z.string() }), req.query).month), 'Substitution report')));

export const myTimetableRoutes = Router();
myTimetableRoutes.get('/', can('timetable.mine'), asyncHandler(async (req: Request, res: Response) => {
    const mine = await tt.myTimetable(req.user!.userId);
    const staff = await db.staff.findFirst({ where: { userId: req.user!.userId }, select: { id: true } });
    successResponse(res, { ...mine, substitutions: staff ? await subs.mySubstitutions(staff.id) : [] }, 'My timetable');
}));
