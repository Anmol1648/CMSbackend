import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import type { UpdateSchoolProfileInput } from './school-profile.schemas';
import { deleteFile, IMAGE_KINDS, readFile, saveUpload } from '../../core/files';

const withTenant = { tenant: { select: { code: true, name: true, status: true } } } as const;

/** The current school's profile (scoped automatically). */
export const getSchoolProfile = async () => {
    const profile = await db.schoolProfile.findFirst({ include: withTenant });
    if (!profile) throw notFound('School profile not found');
    return profile;
};

export const updateSchoolProfile = async (input: UpdateSchoolProfileInput) => {
    const { updatedAt, ...changes } = input;
    const current = await getSchoolProfile();

    if (updatedAt && new Date(updatedAt).getTime() !== current.updatedAt.getTime()) {
        throw conflict('Someone else changed the school profile after you opened it. Reload and try again.');
    }

    return db.schoolProfile.update({
        where: { tenantId: getTenantId()! },
        data: changes,
        include: withTenant,
    });
};

/** What the sign-in page may show before anyone signs in. */
export const getPublicBranding = async () => {
    if (!getTenantId()) throw notFound('No school is set up for this address');
    const p = await getSchoolProfile();
    return {
        code: p.tenant.code,
        name: p.shortName ?? p.legalName,
        legalName: p.legalName,
        // Relative to the API base; ?v= changes with the image so browsers don't show an old one.
        logoUrl: imagePath('logo', p.tenant.code, p.logoFileId),
        dateFormat: p.dateFormat,
        timeZone: p.timeZone,
        login: {
            backgroundUrl: imagePath('login-background', p.tenant.code, p.loginBackgroundFileId),
            backgroundFocus: p.loginBackgroundFocus,
            overlay: p.loginOverlay,
            quote: p.loginQuote,
            quoteAuthor: p.loginQuoteAuthor,
        },
    };
};

// ─── School images (logo, sign-in background) ────────────────────────────────

/** The two images a school can set; both are public (shown before sign-in). */
export const SCHOOL_IMAGES = {
    logo: { field: 'logoFileId', purpose: 'logo', missing: 'This school has no logo' },
    'login-background': { field: 'loginBackgroundFileId', purpose: 'background', missing: 'This school has no sign-in background' },
} as const;
export type SchoolImage = keyof typeof SCHOOL_IMAGES;

const imagePath = (slot: SchoolImage, code: string, fileId: string | null) => (fileId ? `public/school/${slot}?school=${code}&v=${fileId}` : null);

/** Replaces a school image (PNG / JPEG / WebP); the old file is removed. */
export const setSchoolImage = async (slot: SchoolImage, upload: { data: Buffer; originalName: string }) => {
    const spec = SCHOOL_IMAGES[slot];
    const current = await getSchoolProfile();
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: spec.purpose, allowed: IMAGE_KINDS });
    const saved = await db.schoolProfile.update({ where: { tenantId: getTenantId()! }, data: { [spec.field]: file.id }, include: withTenant });
    const old = current[spec.field];
    if (old) await deleteFile(old);
    return saved;
};

export const removeSchoolImage = async (slot: SchoolImage) => {
    const spec = SCHOOL_IMAGES[slot];
    const current = await getSchoolProfile();
    const old = current[spec.field];
    if (!old) return current;
    const saved = await db.schoolProfile.update({ where: { tenantId: getTenantId()! }, data: { [spec.field]: null }, include: withTenant });
    await deleteFile(old);
    return saved;
};

/** An image's bytes for the school in context (public). */
export const schoolImage = async (slot: SchoolImage) => {
    if (!getTenantId()) throw notFound('No school is set up for this address');
    const spec = SCHOOL_IMAGES[slot];
    const p = await getSchoolProfile();
    const id = p[spec.field];
    if (!id) throw notFound(spec.missing);
    return readFile(id);
};
