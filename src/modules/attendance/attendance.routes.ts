import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as calendar from './calendar.service';
import * as students from './student-attendance.service';
import * as staff from './staff-attendance.service';

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

const ANY = ['attendance.view', 'attendance.mark', 'attendance.mark_any', 'attendance.holidays', 'attendance.mine', 'attendance.checkin', 'attendance.staff'];
const REGISTER = ['attendance.view', 'attendance.mark', 'attendance.mark_any'];

export const attendanceRoutes = Router();

// Statuses and the calendar: everyone who works with attendance.
attendanceRoutes.get('/statuses', authenticated, needAny(ANY), asyncHandler(async (_req: Request, res: Response) => successResponse(res, (await students.statuses()).filter((s) => s.isActive), 'Statuses')));
attendanceRoutes.get('/holidays', authenticated, needAny(ANY), asyncHandler(async (req: Request, res: Response) => successResponse(res, await calendar.listHolidays(parse(z.object({ year: z.uuid().optional() }), req.query).year), 'Holidays')));
attendanceRoutes.post('/holidays', can('attendance.holidays'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await calendar.addHoliday(parse(calendar.holidaySchema, req.body)), 'Holiday added', 201)));
attendanceRoutes.delete('/holidays/:id', can('attendance.holidays'), asyncHandler(async (req: Request, res: Response) => {
    await calendar.deleteHoliday(req.params.id);
    successResponse(res, null, 'Holiday removed');
}));

// Students: the register and the day.
attendanceRoutes.get('/sections', authenticated, needAny(['attendance.mark', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.mySections(uid(req)), 'Sections')));
attendanceRoutes.get('/register', authenticated, needAny(REGISTER), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.getRegister(parse(students.registerQuery, req.query), uid(req)), 'Register')));
attendanceRoutes.put('/register', authenticated, needAny(['attendance.mark', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.saveRegister(parse(students.saveSchema, req.body), uid(req)), 'Attendance saved')));
attendanceRoutes.get('/overview', authenticated, needAny(['attendance.view', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.overview(parse(students.overviewQuery, req.query), uid(req)), 'Attendance')));
attendanceRoutes.get('/me', can('attendance.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.myAttendance(parse(students.myQuery, req.query), uid(req)), 'My attendance')));

// Staff: themselves, and the office.
attendanceRoutes.get('/staff/me', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.myDay(uid(req), req.ip), 'Today')));
attendanceRoutes.post('/staff/check-in', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.checkIn(uid(req), req.ip), 'Checked in')));
attendanceRoutes.post('/staff/check-out', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.checkOut(uid(req), req.ip), 'Checked out')));
attendanceRoutes.get('/staff/day', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.staffDay(parse(staff.dayQuery, req.query)), 'Staff attendance')));
attendanceRoutes.put('/staff/:staffId', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.correct(req.params.staffId, parse(staff.correctionSchema, req.body)), 'Saved')));
