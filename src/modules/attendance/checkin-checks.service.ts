import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { saveUpload } from '../../core/files';
import { closestFace, describeFace } from '../../core/face';
import { ATTENDANCE } from './attendance.settings';

/**
 * The checks of a staff check-in / check-out: the live selfie (kept as a file), where the phone is
 * (distance to the nearest school location) and whether the face matches the enrolled one. Anything
 * not right becomes a reason; the check-in then waits for the office (or, outside the school with
 * "block", is refused).
 */

export const checkInInput = z
    .strictObject({
        /** data:image/jpeg;base64,… from the live camera. */
        photo: z.string().max(1_400_000, 'the photo is too big').optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        /** Metres, as the phone reports it. */
        accuracy: z.number().min(0).max(100_000).optional(),
    })
    .default({});
export type CheckInInput = z.infer<typeof checkInInput>;

export type Reason = 'outside' | 'no_location' | 'inaccurate' | 'no_school_location' | 'face_mismatch' | 'no_face' | 'many_faces' | 'no_enrolled_face' | 'no_photo';

export const REASON_TEXT: Record<Reason, string> = {
    outside: 'Outside the school',
    no_location: 'Location not shared',
    inaccurate: 'Location not accurate enough',
    no_school_location: 'No school location is set up',
    face_mismatch: 'Face doesn’t match',
    no_face: 'No face in the photo',
    many_faces: 'More than one face in the photo',
    no_enrolled_face: 'No enrolled face to compare with',
    no_photo: 'No photo',
};

const FACE_LIMIT: Record<string, number> = { relaxed: 0.55, normal: 0.5, strict: 0.42 };

/** Metres between two points on Earth. */
export const metresBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const r = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * r * Math.asin(Math.sqrt(h)));
};

/** A JPEG from a data URL (or plain base64). */
export const jpegOf = (photo: string) => {
    const b64 = photo.startsWith('data:') ? photo.slice(photo.indexOf(',') + 1) : photo;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw badRequest('The photo must be a JPEG from the camera', [{ field: 'photo', message: 'is not a JPEG' }]);
    return buf;
};

export interface CheckResult {
    photoId: string | null;
    lat: number | null;
    lng: number | null;
    accuracy: number | null;
    distance: number | null;
    faceDistance: number | null;
    reasons: Reason[];
    /** "outside" with the school's "block" choice: refuse. */
    blocked: boolean;
}

/** Runs the school's checks on a check-in or check-out. */
export const runChecks = async (staffId: string, input: CheckInInput): Promise<CheckResult> => {
    const s = await getSettings({
        photo: ATTENDANCE.staffPhoto,
        face: ATTENDANCE.staffFace,
        strictness: ATTENDANCE.staffFaceStrictness,
        location: ATTENDANCE.staffLocation,
        accuracy: ATTENDANCE.staffAccuracy,
        outside: ATTENDANCE.staffOutside,
    });
    const reasons: Reason[] = [];
    const out: CheckResult = { photoId: null, lat: input.lat ?? null, lng: input.lng ?? null, accuracy: input.accuracy !== undefined ? Math.round(input.accuracy) : null, distance: null, faceDistance: null, reasons, blocked: false };

    // The selfie.
    let jpeg: Buffer | null = null;
    if (input.photo) jpeg = jpegOf(input.photo);
    if ((s.photo || s.face) && !jpeg) throw badRequest('Take a selfie to check in', [{ field: 'photo', message: 'is required' }]);
    if (jpeg) out.photoId = (await saveUpload({ data: jpeg, originalName: `check-in-${staffId}.jpg`, purpose: 'attendance', allowed: ['jpeg'] })).id;

    // Where the phone is.
    if (s.location) {
        const places = await db.attendanceLocation.findMany({ where: { isActive: true }, select: { latitude: true, longitude: true, radius: true } });
        if (!places.length) reasons.push('no_school_location');
        else if (out.lat === null || out.lng === null) reasons.push('no_location');
        else {
            const nearest = places.map((p) => ({ d: metresBetween({ lat: out.lat!, lng: out.lng! }, { lat: p.latitude, lng: p.longitude }), r: p.radius })).sort((a, b) => a.d - b.d)[0];
            out.distance = nearest.d;
            if (out.accuracy !== null && out.accuracy > s.accuracy) reasons.push('inaccurate');
            else if (nearest.d > nearest.r) {
                reasons.push('outside');
                out.blocked = s.outside === 'block';
            }
        }
    }

    // Is it the same person.
    if (s.face && jpeg) {
        const enrolled = await db.staffFace.findFirst({ where: { staffId, status: 'approved' }, select: { descriptors: true } });
        if (!enrolled) reasons.push('no_enrolled_face');
        else {
            const face = await describeFace(jpeg);
            if (!face.descriptor) reasons.push('no_face');
            else {
                if (face.faces > 1) reasons.push('many_faces');
                const d = closestFace(face.descriptor, enrolled.descriptors as number[][]);
                out.faceDistance = d === null ? null : Math.round(d * 1000) / 1000;
                if (d === null || d > (FACE_LIMIT[s.strictness] ?? 0.5)) reasons.push('face_mismatch');
            }
        }
    }
    return out;
};
