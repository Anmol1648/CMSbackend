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
        // Relative to the API base; ?v= changes with the logo so browsers don't show an old one.
        logoUrl: p.logoFileId ? `public/school/logo?school=${p.tenant.code}&v=${p.logoFileId}` : null,
        dateFormat: p.dateFormat,
        timeZone: p.timeZone,
    };
};

/** Replaces the school's logo (PNG / JPEG / WebP). */
export const setSchoolLogo = async (upload: { data: Buffer; originalName: string }) => {
    const current = await getSchoolProfile();
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'logo', allowed: IMAGE_KINDS });
    const saved = await db.schoolProfile.update({ where: { tenantId: getTenantId()! }, data: { logoFileId: file.id }, include: withTenant });
    if (current.logoFileId) await deleteFile(current.logoFileId);
    return saved;
};

export const removeSchoolLogo = async () => {
    const current = await getSchoolProfile();
    if (!current.logoFileId) return current;
    const saved = await db.schoolProfile.update({ where: { tenantId: getTenantId()! }, data: { logoFileId: null }, include: withTenant });
    await deleteFile(current.logoFileId);
    return saved;
};

/** The logo's bytes for the school of this address (public: shown on the sign-in page). */
export const schoolLogo = async () => {
    if (!getTenantId()) throw notFound('No school is set up for this address');
    const p = await getSchoolProfile();
    if (!p.logoFileId) throw notFound('This school has no logo');
    return readFile(p.logoFileId);
};
