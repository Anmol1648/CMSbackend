import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { saveUpload } from '../../core/files';
import { closestFace, describeFace, faceDistance, FaceResult } from '../../core/face';
import { ATTENDANCE } from './attendance.settings';

/**
 * The checks of a staff check-in / check-out, each switched on by the school: the live selfie (kept as
 * a file), liveness (a second photo with the head turned), where the phone is (distance to the nearest
 * school location), whether the face matches the enrolled one, and whether it is the person's own
 * phone. Anything not right becomes a reason; the check-in then waits for the office, or is refused
 * where the school chose "block".
 */

export const checkInInput = z
    .strictObject({
        /** data:image/jpeg;base64,… from the live camera, looking straight. */
        photo: z.string().max(1_400_000, 'the photo is too big').optional(),
        /** Liveness: the second photo, head turned. */
        photo2: z.string().max(1_400_000, 'the photo is too big').optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        /** Metres, as the phone reports it. */
        accuracy: z.number().min(0).max(100_000).optional(),
        /** The random id this browser keeps (registered-phone lock), and what it is. */
        deviceId: z.string().trim().min(8).max(100).optional(),
        deviceLabel: z.string().trim().max(100).optional(),
    })
    .default({});
export type CheckInInput = z.infer<typeof checkInInput>;

export type Reason =
    | 'outside'
    | 'no_location'
    | 'inaccurate'
    | 'no_school_location'
    | 'face_mismatch'
    | 'no_face'
    | 'many_faces'
    | 'no_enrolled_face'
    | 'no_photo'
    | 'not_live'
    | 'other_phone'
    | 'no_phone_id';

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
    not_live: 'Head not turned in the second photo (liveness)',
    other_phone: 'Not the person’s registered phone',
    no_phone_id: 'Phone not recognised',
};

const FACE_LIMIT: Record<string, number> = { relaxed: 0.55, normal: 0.5, strict: 0.42 };
/** The head must turn at least this much between the two photos (in eye widths). */
const TURN = 0.12;

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

export const phoneHash = (deviceId: string) => crypto.createHash('sha256').update(deviceId).digest('hex');

export interface CheckResult {
    photoId: string | null;
    lat: number | null;
    lng: number | null;
    accuracy: number | null;
    distance: number | null;
    faceDistance: number | null;
    reasons: Reason[];
    /** The school chose "block" for what happened: refuse, with this message. */
    blockMessage: string | null;
}

/** Runs the school's checks on a check-in or check-out. */
export const runChecks = async (staffId: string, input: CheckInInput): Promise<CheckResult> => {
    const s = await getSettings({
        photo: ATTENDANCE.staffPhoto,
        face: ATTENDANCE.staffFace,
        liveness: ATTENDANCE.staffLiveness,
        strictness: ATTENDANCE.staffFaceStrictness,
        location: ATTENDANCE.staffLocation,
        accuracy: ATTENDANCE.staffAccuracy,
        outside: ATTENDANCE.staffOutside,
        phoneLock: ATTENDANCE.staffPhoneLock,
    });
    const reasons: Reason[] = [];
    const out: CheckResult = { photoId: null, lat: input.lat ?? null, lng: input.lng ?? null, accuracy: input.accuracy !== undefined ? Math.round(input.accuracy) : null, distance: null, faceDistance: null, reasons, blockMessage: null };

    // The person's own phone.
    if (s.phoneLock !== 'off') {
        if (!input.deviceId) reasons.push('no_phone_id');
        else {
            const hash = phoneHash(input.deviceId);
            const mine = await db.staffPhone.findFirst({ where: { staffId } });
            if (!mine) await db.staffPhone.create({ data: { tenantId: getTenantId()!, staffId, deviceHash: hash, label: input.deviceLabel || 'Phone' } });
            else if (mine.deviceHash !== hash) {
                if (s.phoneLock === 'block') {
                    out.blockMessage = `This is not your registered phone (${mine.label}). Check in from your own phone, or ask the office to reset it.`;
                    return out;
                }
                reasons.push('other_phone');
            }
        }
    }

    // The selfie (and the turned one for liveness).
    const jpeg = input.photo ? jpegOf(input.photo) : null;
    const jpeg2 = input.photo2 ? jpegOf(input.photo2) : null;
    if ((s.photo || s.face || s.liveness) && !jpeg) throw badRequest('Take a selfie to check in', [{ field: 'photo', message: 'is required' }]);

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
                if (s.outside === 'block') {
                    out.blockMessage = `You are about ${nearest.d >= 1000 ? `${(nearest.d / 1000).toFixed(1)} km` : `${nearest.d} m`} from the school. Check in when you reach school.`;
                    return out;
                }
                reasons.push('outside');
            }
        }
    }

    // The face (and liveness) only when the school uses them: the models load only then.
    let face: FaceResult | null = null;
    if (jpeg && (s.face || s.liveness)) face = await describeFace(jpeg);
    if (s.face && jpeg) {
        const enrolled = await db.staffFace.findFirst({ where: { staffId, status: 'approved' }, select: { descriptors: true } });
        if (!enrolled) reasons.push('no_enrolled_face');
        else if (!face?.descriptor) reasons.push('no_face');
        else {
            if (face.faces > 1) reasons.push('many_faces');
            const d = closestFace(face.descriptor, enrolled.descriptors as number[][]);
            out.faceDistance = d === null ? null : Math.round(d * 1000) / 1000;
            if (d === null || d > (FACE_LIMIT[s.strictness] ?? 0.5)) reasons.push('face_mismatch');
        }
    }
    if (s.liveness && jpeg) {
        // A real person turns their head between the two photos; a printed photo can't.
        const turned = jpeg2 ? await describeFace(jpeg2) : null;
        const same = !!face?.descriptor && !!turned?.descriptor && faceDistance(face.descriptor, turned.descriptor) <= 0.6;
        const moved = face?.yaw !== null && face?.yaw !== undefined && turned?.yaw !== null && turned?.yaw !== undefined && Math.abs(turned.yaw - face.yaw) >= TURN;
        if (!same || !moved) reasons.push('not_live');
    }

    // Keep the selfie only once nothing refused the check-in.
    if (jpeg) out.photoId = (await saveUpload({ data: jpeg, originalName: `check-in-${staffId}.jpg`, purpose: 'attendance', allowed: ['jpeg'] })).id;
    return out;
};
