import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, successResponse } from '../../core/index';
import { badRequest, validationError } from '../../core/errors';
import { authenticated, can } from '../../middlewares/access';
import { readFile, saveUpload } from '../../core/files';
import { sendFile, upload } from '../../core/http/files';
import { need, searchStudents } from './cocurricular.common';
import * as houses from './houses.service';
import * as clubs from './clubs.service';
import * as comp from './competitions.service';

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body ?? {});
    if (!r.success) throw validationError(r.error);
    return r.data;
};
const uid = (req: Request) => req.user!.userId;
/** Signed in with any of these permissions (the services check the exact one again). */
const any = (keys: string[]) => [authenticated, asyncHandler(async (req: Request, _res: Response, next: () => void) => (await need(uid(req), keys), next()))];
const STAFF = ['cocurricular.view', 'house.manage', 'house.points', 'club.manage', 'club.run', 'competition.manage', 'achievement.record'];

export const cocurricularRoutes = Router();

// Shared.
cocurricularRoutes.get('/students', ...any(STAFF), asyncHandler(async (req: Request, res: Response) => {
    const q = parse(z.object({ q: z.string().max(60).default(''), classes: z.string().max(4000).optional() }), req.query);
    successResponse(res, await searchStudents(q.q, q.classes ? q.classes.split(',').filter(Boolean) : []), 'Students');
}));
cocurricularRoutes.post('/files', ...any(['club.manage', 'club.run', 'achievement.record']), upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw badRequest('Choose a file');
    const f = await saveUpload({ data: req.file.buffer, originalName: req.file.originalname, purpose: 'document', allowed: ['jpeg', 'png', 'webp', 'pdf'] });
    successResponse(res, { id: f.id, name: f.originalName }, 'Uploaded', 201);
}));
cocurricularRoutes.get('/student/:id', ...any(STAFF), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.studentActivities(req.params.id, uid(req)), 'Activities')));
cocurricularRoutes.get('/mine', can('cocurricular.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.myActivities(uid(req)), 'Activities')));

// Houses.
cocurricularRoutes.get('/houses', ...any(['cocurricular.view', 'house.manage', 'house.points']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.overview(uid(req)), 'Houses')));
cocurricularRoutes.get('/houses/strength', ...any(['cocurricular.view', 'house.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.strengthFor(uid(req)), 'Strength')));
cocurricularRoutes.get('/houses/points', ...any(['cocurricular.view', 'house.manage', 'house.points']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.pointsLog(parse(houses.pointsQuery, req.query), uid(req)), 'Points')));
cocurricularRoutes.post('/houses/points', can('house.points'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.givePoints(parse(houses.pointsSchema, req.body), uid(req)), 'Points given', 201)));
cocurricularRoutes.delete('/houses/points/:id', can('house.points'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.removePoints(req.params.id, uid(req)), 'Removed')));
cocurricularRoutes.post('/houses/allocate', can('house.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.allocate(parse(houses.allocateSchema, req.body), uid(req)), 'Allocation')));
cocurricularRoutes.put('/houses/student/:studentId', can('house.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.setStudentHouse(req.params.studentId, parse(z.strictObject({ houseId: z.uuid().nullable() }), req.body).houseId, uid(req)), 'Saved')));
cocurricularRoutes.get('/houses/:id/students', ...any(['cocurricular.view', 'house.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.houseStudents(req.params.id, parse(z.object({ section: z.uuid().optional() }), req.query).section, uid(req)), 'Students')));
cocurricularRoutes.put('/houses/:id/officials', can('house.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await houses.setOfficials(req.params.id, parse(houses.officialsSchema, req.body), uid(req)), 'Saved')));

// Clubs.
cocurricularRoutes.get('/clubs/options', ...any(['cocurricular.view', 'club.manage', 'club.run']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await clubs.clubOptions(), 'Options')));
cocurricularRoutes.get('/clubs', ...any(['cocurricular.view', 'club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.listClubs(uid(req)), 'Clubs')));
cocurricularRoutes.post('/clubs', can('club.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.createClub(parse(clubs.clubSchema, req.body), uid(req)), 'Club added', 201)));
cocurricularRoutes.put('/clubs/members/:memberId', ...any(['club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.updateMember(req.params.memberId, parse(clubs.memberSchema, req.body), uid(req)), 'Saved')));
cocurricularRoutes.put('/clubs/meetings/:meetingId', ...any(['club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.updateMeeting(req.params.meetingId, parse(clubs.meetingSchema, req.body), uid(req)), 'Saved')));
cocurricularRoutes.delete('/clubs/meetings/:meetingId', ...any(['club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.deleteMeeting(req.params.meetingId, uid(req)), 'Deleted')));
cocurricularRoutes.get('/clubs/meetings/:meetingId/photos/:fileId', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const { file, data } = await readFile(await clubs.meetingPhoto(req.params.meetingId, req.params.fileId, uid(req)));
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
cocurricularRoutes.post('/clubs/:id/request', can('cocurricular.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.requestJoin(req.params.id, parse(clubs.requestSchema, req.body), uid(req)), 'Request sent', 201)));
cocurricularRoutes.delete('/clubs/requests/:memberId', can('cocurricular.mine'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.cancelRequest(req.params.memberId, uid(req)), 'Request cancelled')));
cocurricularRoutes.get('/clubs/:id', ...any(['cocurricular.view', 'club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.getClub(req.params.id, uid(req)), 'Club')));
cocurricularRoutes.put('/clubs/:id', can('club.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.updateClub(req.params.id, parse(clubs.clubSchema, req.body), uid(req)), 'Saved')));
cocurricularRoutes.delete('/clubs/:id', can('club.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.deleteClub(req.params.id, uid(req)), 'Deleted')));
cocurricularRoutes.post('/clubs/:id/members', ...any(['club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.addMembers(req.params.id, parse(clubs.addMembersSchema, req.body), uid(req)), 'Added')));
cocurricularRoutes.post('/clubs/:id/meetings', ...any(['club.manage', 'club.run']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await clubs.addMeeting(req.params.id, parse(clubs.meetingSchema, req.body), uid(req)), 'Saved', 201)));

// Competitions.
cocurricularRoutes.get('/competitions/options', ...any(['cocurricular.view', 'competition.manage', 'achievement.record']), asyncHandler(async (_req: Request, res: Response) => successResponse(res, await comp.competitionOptions(), 'Options')));
cocurricularRoutes.get('/competitions', ...any(['cocurricular.view', 'competition.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.listCompetitions(parse(comp.listQuery, req.query), uid(req)), 'Competitions')));
cocurricularRoutes.post('/competitions', can('competition.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.createCompetition(parse(comp.competitionSchema, req.body), uid(req)), 'Competition added', 201)));
cocurricularRoutes.get('/competitions/:id', ...any(['cocurricular.view', 'competition.manage']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.getCompetition(req.params.id, uid(req)), 'Competition')));
cocurricularRoutes.put('/competitions/:id', can('competition.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.updateCompetition(req.params.id, parse(comp.competitionSchema, req.body), uid(req)), 'Saved')));
cocurricularRoutes.delete('/competitions/:id', can('competition.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.deleteCompetition(req.params.id, uid(req)), 'Deleted')));
cocurricularRoutes.put('/competitions/:id/entries', can('competition.manage'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.saveEntries(req.params.id, parse(comp.entriesSchema, req.body), uid(req)), 'Saved')));

// Outside achievements.
cocurricularRoutes.get('/achievements', ...any(['cocurricular.view', 'achievement.record']), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.listAchievements(parse(comp.achievementsQuery, req.query), uid(req)), 'Achievements')));
cocurricularRoutes.post('/achievements', can('achievement.record'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.recordAchievement(parse(comp.achievementSchema, req.body), uid(req)), 'Recorded', 201)));
cocurricularRoutes.delete('/achievements/:id', can('achievement.record'), asyncHandler(async (req: Request, res: Response) => successResponse(res, await comp.deleteAchievement(req.params.id, uid(req)), 'Deleted')));
cocurricularRoutes.get('/achievements/:id/certificate', authenticated, asyncHandler(async (req: Request, res: Response) => {
    const { file, data } = await readFile(await comp.achievementFile(req.params.id, uid(req)));
    sendFile(res, file.originalName, file.mimeType, data, { inline: true });
}));
