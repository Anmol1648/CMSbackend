import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { conflict, notFound } from '../../core/errors';
import type { UpdateSchoolProfileInput } from './school-profile.schemas';

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
        logoUrl: null as string | null, // files arrive in F8
        dateFormat: p.dateFormat,
        timeZone: p.timeZone,
    };
};
