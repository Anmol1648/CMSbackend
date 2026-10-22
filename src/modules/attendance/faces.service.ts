import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { deleteFile, saveUpload } from '../../core/files';
import { describeFace, faceDistance } from '../../core/face';
import { fullName } from '../students/students.service';
import { ATTENDANCE } from './attendance.settings';
import { jpegOf } from './checkin-checks.service';

/**
 * Staff faces for the face check at check-in: the office enrols a person (3 photos), or the person
 * enrols themselves and the office approves. Only the descriptors are compared; the photos stay for
 * the office to see.
 */

export const enrolSchema = z.strictObject({ photos: z.array(z.string().max(1_400_000)).min(1, 'take at least one photo').max(5) });

const enrol = async (staffId: string, photos: string[], status: 'approved' | 'pending', userId: string) => {
    const descriptors: number[][] = [];
    const jpegs = photos.map(jpegOf);
    for (const [i, jpeg] of jpegs.entries()) {
        const f = await describeFace(jpeg);
        if (!f.descriptor) throw badRequest(`Photo ${i + 1}: no face found. Face the camera in good light.`, [{ field: `photos.${i}`, message: 'has no face' }]);
        if (f.faces > 1) throw badRequest(`Photo ${i + 1}: more than one face. Only the person should be in the photo.`, [{ field: `photos.${i}`, message: 'has more than one face' }]);
        descriptors.push(f.descriptor);
    }
    // The photos must be of one person.
    for (let i = 1; i < descriptors.length; i++) if (faceDistance(descriptors[0], descriptors[i]) > 0.6) throw badRequest('The photos don’t look like the same person. Take them again.');
    const photoIds: string[] = [];
    for (const jpeg of jpegs) photoIds.push((await saveUpload({ data: jpeg, originalName: `face-${staffId}.jpg`, purpose: 'face', allowed: ['jpeg'] })).id);
    const old = await db.staffFace.findFirst({ where: { staffId } });
    const tenantId = getTenantId()!;
    const data = { descriptors, photoIds, status, approvedBy: status === 'approved' ? userId : null, approvedAt: status === 'approved' ? new Date() : null };
    await db.staffFace.upsert({ where: { staffId_tenantId: { staffId, tenantId } }, create: { tenantId, staffId, ...data }, update: data });
    if (old) for (const id of old.photoIds) await deleteFile(id);
    await recordAudit({ action: status === 'approved' ? 'staff_face_enrolled' : 'staff_face_enrol_asked', entity: 'staff_face', entityId: staffId });
};

// ─── The office ──────────────────────────────────────────────────────────────

/** Every working staff member with their face enrolment. */
export const listFaces = async () => {
    const staff = await db.staff.findMany({
        where: { status: 'working' },
        select: { id: true, employeeCode: true, firstName: true, middleName: true, lastName: true, designation: { select: { name: true } }, face: { select: { status: true, photoIds: true, updatedAt: true, approvedAt: true } } },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return staff.map((s) => ({
        id: s.id,
        name: fullName(s),
        employeeCode: s.employeeCode,
        designation: s.designation?.name ?? null,
        face: s.face ? { status: s.face.status, photoIds: s.face.photoIds, enrolledAt: s.face.updatedAt } : null,
    }));
};

const staffOrThrow = async (staffId: string) => {
    if (!z.uuid().safeParse(staffId).success) throw notFound('Staff not found');
    const s = await db.staff.findFirst({ where: { id: staffId }, select: { id: true } });
    if (!s) throw notFound('Staff not found');
    return s;
};

export const enrolByOffice = async (staffId: string, input: z.infer<typeof enrolSchema>, userId: string) => {
    await staffOrThrow(staffId);
    await enrol(staffId, input.photos, 'approved', userId);
    return listFaces();
};

export const approveFace = async (staffId: string, userId: string) => {
    await staffOrThrow(staffId);
    const f = await db.staffFace.findFirst({ where: { staffId } });
    if (!f || f.status !== 'pending') throw badRequest('There is no enrolment waiting for this person');
    await db.staffFace.update({ where: { id: f.id }, data: { status: 'approved', approvedBy: userId, approvedAt: new Date() } });
    await recordAudit({ action: 'staff_face_approved', entity: 'staff_face', entityId: staffId });
    return listFaces();
};

export const removeFace = async (staffId: string) => {
    await staffOrThrow(staffId);
    const f = await db.staffFace.findFirst({ where: { staffId } });
    if (f) {
        await db.staffFace.delete({ where: { id: f.id } });
        for (const id of f.photoIds) await deleteFile(id);
        await recordAudit({ action: 'staff_face_removed', entity: 'staff_face', entityId: staffId });
    }
    return listFaces();
};

// ─── The person themself ─────────────────────────────────────────────────────

export const myFace = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true, face: { select: { status: true, updatedAt: true } } } });
    if (!staff) throw badRequest('Your login is not linked to a staff record');
    const { selfEnrol } = await getSettings({ selfEnrol: ATTENDANCE.staffSelfEnrol });
    return { face: staff.face ? { status: staff.face.status, enrolledAt: staff.face.updatedAt } : null, canEnrol: selfEnrol };
};

/** The person enrols their own face; it is used once the office approves it. */
export const enrolSelf = async (userId: string, input: z.infer<typeof enrolSchema>) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) throw badRequest('Your login is not linked to a staff record');
    const { selfEnrol } = await getSettings({ selfEnrol: ATTENDANCE.staffSelfEnrol });
    if (!selfEnrol) throw forbidden('Faces are enrolled by the office');
    await enrol(staff.id, input.photos, 'pending', userId);
    return myFace(userId);
};

// ─── School locations (geo-fence) ────────────────────────────────────────────

export const locationSchema = z.strictObject({
    name: z.string().trim().min(2).max(80),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radius: z.number().int().min(20, 'at least 20 m').max(5000, 'at most 5 km'),
    isActive: z.boolean().default(true),
});

export const listLocations = () => db.attendanceLocation.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, latitude: true, longitude: true, radius: true, isActive: true } });

export const saveLocation = async (id: string | null, input: z.infer<typeof locationSchema>) => {
    if (id) {
        if (!z.uuid().safeParse(id).success || !(await db.attendanceLocation.findFirst({ where: { id } }))) throw notFound('Location not found');
        await db.attendanceLocation.update({ where: { id }, data: input });
    } else await db.attendanceLocation.create({ data: { tenantId: getTenantId()!, ...input } });
    await recordAudit({ action: 'attendance_location_saved', entity: 'attendance_location', changes: { name: input.name, radius: input.radius } });
    return listLocations();
};

export const deleteLocation = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Location not found');
    await db.attendanceLocation.deleteMany({ where: { id } });
    return listLocations();
};
