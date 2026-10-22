import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { forbidden, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { getUserAccess } from '../rbac/access.service';
import * as calendar from './calendar.service';
import * as students from './student-attendance.service';
import * as staff from './staff-attendance.service';
import * as leave from './leave.service';
import * as faces from './faces.service';
import { checkInInput } from './checkin-checks.service';
import { readFile } from '../../core/files';

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
attendanceRoutes.get('/students', authenticated, needAny(['attendance.view', 'attendance.mark', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.studentList(parse(students.studentListQuery, req.query), uid(req)), 'Students')));
attendanceRoutes.get('/student', authenticated, needAny(['attendance.view', 'attendance.mark', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.studentAttendance(parse(students.studentQuery, req.query), uid(req)), 'Student attendance')));
attendanceRoutes.get('/me', can('attendance.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.myAttendance(parse(students.myQuery, req.query), uid(req)), 'My attendance')));

// Staff: themselves, and the office.
attendanceRoutes.get('/staff/me/month', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.myMonth(uid(req), parse(staff.myMonthQuery, req.query).month), 'My attendance')));
attendanceRoutes.get('/staff/me', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.myDay(uid(req), req.ip), 'Today')));
attendanceRoutes.post('/staff/check-in', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.checkIn(uid(req), req.ip, parse(checkInInput, req.body)), 'Checked in')));
attendanceRoutes.post('/staff/check-out', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.checkOut(uid(req), req.ip, parse(checkInInput, req.body)), 'Checked out')));
attendanceRoutes.get('/staff/day', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.staffDay(parse(staff.dayQuery, req.query)), 'Staff attendance')));
attendanceRoutes.put('/staff/:staffId', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.correct(req.params.staffId, parse(staff.correctionSchema, req.body)), 'Saved')));

// Period mode: a teacher's lessons of a day.
attendanceRoutes.get('/lessons', authenticated, needAny(['attendance.mark', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await students.myLessons(uid(req), parse(z.object({ date: z.iso.date().optional() }), req.query).date), 'Lessons')));

// Student leave: asked by parents / students (or recorded by the office), decided by the class teacher / office.
const MARKERS = ['attendance.mark', 'attendance.mark_any'];
attendanceRoutes.post('/leave', authenticated, needAny(['attendance.mine', 'attendance.mark_any']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.applyLeave(parse(leave.applySchema, req.body), uid(req)), 'Leave asked', 201)));
attendanceRoutes.get('/leave/mine', can('attendance.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.myLeaves(parse(z.object({ student: z.uuid() }), req.query).student, uid(req)), 'Leave')));
attendanceRoutes.post('/leave/:id/cancel', authenticated, asyncHandler(async (req: Request, res: Response) => {
    await leave.cancelLeave(req.params.id, uid(req));
    successResponse(res, null, 'Cancelled');
}));
attendanceRoutes.get('/leave', authenticated, needAny(MARKERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.leaveRequests(parse(leave.listQuery, req.query), uid(req)), 'Leave requests')));
attendanceRoutes.post('/leave/:id/decide', authenticated, needAny(MARKERS), asyncHandler(async (req: Request, res: Response) => successResponse(res, await leave.decideLeave(req.params.id, parse(leave.decideSchema, req.body), uid(req)), 'Saved')));

// Staff correction requests.
attendanceRoutes.post('/staff/requests', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.askCorrection(uid(req), parse(staff.requestSchema, req.body)), 'Request sent', 201)));
attendanceRoutes.get('/staff/requests/mine', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.myRequests(uid(req)), 'My requests')));
attendanceRoutes.get('/staff/requests', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.correctionRequests(parse(staff.requestsQuery, req.query)), 'Requests')));
attendanceRoutes.post('/staff/requests/:id/decide', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.decideCorrection(req.params.id, parse(leave.decideSchema, req.body), uid(req)), 'Saved')));

// Check-ins waiting for approval, photos, faces, locations.
attendanceRoutes.get('/staff/pending', can('attendance.staff'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await staff.pendingCheckIns(), 'Waiting')));
attendanceRoutes.post('/staff/pending/:id/decide', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await staff.decideCheckIn(req.params.id, parse(staff.approvalSchema, req.body), uid(req)), 'Saved')));
attendanceRoutes.get('/staff/photo/:fileId', authenticated, needAny(['attendance.staff', 'attendance.checkin']), asyncHandler(async (req: Request, res: Response) => {
    const a = await getUserAccess(uid(req));
    const id = await staff.photoFor(req.params.fileId, uid(req), !!a.permissions['attendance.staff']);
    const { file, data } = await readFile(id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(data);
}));
attendanceRoutes.get('/faces', can('attendance.staff'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await faces.listFaces(), 'Faces')));
attendanceRoutes.post('/faces/:staffId', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.enrolByOffice(req.params.staffId, parse(faces.enrolSchema, req.body), uid(req)), 'Face enrolled')));
attendanceRoutes.post('/faces/:staffId/approve', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.approveFace(req.params.staffId, uid(req)), 'Approved')));
attendanceRoutes.delete('/faces/:staffId', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.removeFace(req.params.staffId), 'Removed')));
attendanceRoutes.get('/my-face', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.myFace(uid(req)), 'My face')));
attendanceRoutes.post('/my-face', can('attendance.checkin'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.enrolSelf(uid(req), parse(faces.enrolSchema, req.body)), 'Sent for approval')));
attendanceRoutes.get('/locations', can('attendance.staff'), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await faces.listLocations(), 'Locations')));
attendanceRoutes.post('/locations', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.saveLocation(null, parse(faces.locationSchema, req.body)), 'Location added', 201)));
attendanceRoutes.put('/locations/:id', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.saveLocation(req.params.id, parse(faces.locationSchema, req.body)), 'Saved')));
attendanceRoutes.delete('/locations/:id', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.deleteLocation(req.params.id), 'Removed')));
attendanceRoutes.delete('/phones/:staffId', can('attendance.staff'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await faces.resetPhone(req.params.staffId), 'Phone reset')));
