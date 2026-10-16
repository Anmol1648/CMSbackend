import { db } from '../../core/db';
import { notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { deleteFile, IMAGE_KINDS, readFile, saveUpload } from '../../core/files';

/**
 * Profile photos (PNG / JPEG / WebP). Shown to signed-in people of the same school only, so they are
 * served from an authenticated route; ?v= changes with the photo so browsers don't show an old one.
 */

export const avatarPath = (u: { id: string; avatarFileId: string | null }) => (u.avatarFileId ? `users/${u.id}/avatar?v=${u.avatarFileId}` : null);

const current = async (userId: string) => {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, avatarFileId: true } });
    if (!user) throw notFound('User not found');
    return user;
};

/** Replaces someone's photo; the old file is removed. */
export const setAvatar = async (userId: string, upload: { data: Buffer; originalName: string }) => {
    const before = await current(userId);
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'avatar', allowed: IMAGE_KINDS });
    await db.user.update({ where: { id: userId }, data: { avatarFileId: file.id } });
    if (before.avatarFileId) await deleteFile(before.avatarFileId);
    await recordAudit({ action: 'update', entity: 'user', entityId: userId, changes: { photo: [before.avatarFileId ? 'photo' : null, 'new photo'] } });
    return avatarPath({ id: userId, avatarFileId: file.id });
};

export const removeAvatar = async (userId: string) => {
    const before = await current(userId);
    if (!before.avatarFileId) return null;
    await db.user.update({ where: { id: userId }, data: { avatarFileId: null } });
    await deleteFile(before.avatarFileId);
    await recordAudit({ action: 'update', entity: 'user', entityId: userId, changes: { photo: ['photo', null] } });
    return null;
};

/** The photo's bytes (any signed-in person of the school). */
export const readAvatar = async (userId: string) => {
    const user = await current(userId);
    if (!user.avatarFileId) throw notFound('No photo');
    return readFile(user.avatarFileId);
};
