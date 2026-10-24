import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { usersOf } from '../alerts/recipients';
import { defineDailyJob } from '../alerts/jobs';
import { SHARED } from './uploads.settings';

/**
 * Shared files (the Downloads library): folders and files (or links) with who can see them:
 * everyone, staff, or chosen roles / sections (with their parents) / people; a file follows its
 * folder unless set otherwise, and a folder its parent. Teachers add files for their own sections
 * into folders open to them. Files can expire, have versions, and need an acknowledgement.
 */

const DAY = 86_400_000;

// ─── Who sees what ───────────────────────────────────────────────────────────

interface Rule {
    audience: string;
    roleSlugs: string[];
    sectionIds: string[];
    userIds: string[];
    withParents: boolean;
}
type FolderRow = Rule & { id: string; parentId: string | null; inherit: boolean; name: string; staffAdd: boolean };
interface Viewer {
    userId: string;
    kind: string;
    roles: string[];
    sections: string[];
    manage: boolean;
    add: boolean;
    reports: boolean;
}

/** Who someone is, for visibility: kind, roles, the sections they belong to (student, a parent's children, a teacher's classes). */
export const viewerOf = async (userId: string): Promise<Viewer> => {
    const [u, a, year] = await Promise.all([db.user.findFirst({ where: { id: userId }, select: { kind: true, roles: { select: { role: { select: { slug: true } } } } } }), getUserAccess(userId), currentYear()]);
    let sections: string[] = [];
    if (year && u) {
        if (u.kind === 'staff') {
            const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
            if (staff) sections = (await db.section.findMany({ where: { academicYearId: year.id, OR: [{ classTeacherId: staff.id }, { teachingAssignments: { some: { staffId: staff.id } } }] }, select: { id: true } })).map((s) => s.id);
        } else {
            const kids = await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } });
            sections = (await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: kids.map((k) => k.id) } }, select: { sectionId: true } })).map((e) => e.sectionId);
        }
    }
    return { userId, kind: u?.kind ?? 'staff', roles: u?.roles.map((r) => r.role.slug) ?? [], sections, manage: !!a.permissions['upload.manage'], add: !!a.permissions['upload.add'], reports: !!a.permissions['upload.reports'] };
};

const allows = (r: Rule, v: Viewer) => {
    if (r.audience === 'everyone') return true;
    if (r.audience === 'staff') return v.kind === 'staff';
    if (r.userIds.includes(v.userId) || r.roleSlugs.some((x) => v.roles.includes(x))) return true;
    if (r.sectionIds.some((s) => v.sections.includes(s))) return v.kind !== 'guardian' || r.withParents;
    return false;
};

/** A folder's rule, following "same as the parent" up the tree (the top is everyone). */
const folderRule = (f: FolderRow | undefined, byId: Map<string, FolderRow>, depth = 0): Rule => {
    if (!f || depth > 20) return { audience: 'everyone', roleSlugs: [], sectionIds: [], userIds: [], withParents: true };
    if (!f.inherit) return f;
    return f.parentId ? folderRule(byId.get(f.parentId), byId, depth + 1) : { audience: 'everyone', roleSlugs: [], sectionIds: [], userIds: [], withParents: true };
};
const loadFolders = async () => {
    const rows = await db.uploadFolder.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    return { rows, byId: new Map(rows.map((f) => [f.id, f as FolderRow])) };
};
const itemRule = (i: Rule & { inherit: boolean; folderId: string }, byId: Map<string, FolderRow>) => (i.inherit ? folderRule(byId.get(i.folderId), byId) : i);

/** Everyone a rule reaches (for alerts and acknowledgement tracking); at most a few thousand. */
const audienceUsers = async (r: Rule): Promise<string[]> => {
    if (r.audience === 'everyone') return (await db.user.findMany({ where: { status: 'active' }, select: { id: true }, take: 5000 })).map((u) => u.id);
    if (r.audience === 'staff') return (await db.user.findMany({ where: { status: 'active', kind: 'staff' }, select: { id: true } })).map((u) => u.id);
    const ids = new Set(r.userIds);
    if (r.roleSlugs.length) for (const u of await db.user.findMany({ where: { status: 'active', roles: { some: { role: { slug: { in: r.roleSlugs } } } } }, select: { id: true } })) ids.add(u.id);
    if (r.sectionIds.length) {
        const year = await currentYear();
        if (year) {
            const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: { in: r.sectionIds }, student: { status: 'active' } }, select: { student: { select: { userId: true, familyId: true } } } });
            for (const e of enrol) if (e.student.userId) ids.add(e.student.userId);
            if (r.withParents) for (const g of await db.guardian.findMany({ where: { familyId: { in: enrol.map((e) => e.student.familyId!).filter(Boolean) }, userId: { not: null } }, select: { userId: true } })) ids.add(g.userId!);
            const sections = await db.section.findMany({ where: { id: { in: r.sectionIds } }, select: { classTeacherId: true, teachingAssignments: { select: { staffId: true } } } });
            const staffIds = [...new Set(sections.flatMap((s) => [s.classTeacherId, ...s.teachingAssignments.map((t) => t.staffId)]).filter((x): x is string => !!x))];
            for (const s of await db.staff.findMany({ where: { id: { in: staffIds }, userId: { not: null } }, select: { userId: true } })) ids.add(s.userId!);
        }
    }
    return [...ids];
};

const ruleSchema = { inherit: z.boolean().default(true), audience: z.enum(['everyone', 'staff', 'custom']).default('everyone'), roleSlugs: z.array(z.string().max(60)).max(30).default([]), sectionIds: z.array(z.uuid()).max(300).default([]), userIds: z.array(z.uuid()).max(500).default([]), withParents: z.boolean().default(true) };
const describe = async (r: Rule) => {
    if (r.audience === 'everyone') return 'Everyone';
    if (r.audience === 'staff') return 'All staff';
    const parts: string[] = [];
    if (r.roleSlugs.length) parts.push((await db.role.findMany({ where: { slug: { in: r.roleSlugs } }, select: { name: true } })).map((x) => x.name).join(', '));
    if (r.sectionIds.length) parts.push(`${r.sectionIds.length} section${r.sectionIds.length === 1 ? '' : 's'}${r.withParents ? ' (and parents)' : ''}`);
    if (r.userIds.length) parts.push(`${r.userIds.length} people`);
    return parts.join(' · ') || 'No one yet';
};

// ─── Folders ─────────────────────────────────────────────────────────────────

export const folderSchema = z.strictObject({ parentId: z.uuid().nullable().optional(), name: z.string().trim().min(1, 'is required').max(80), description: z.string().trim().max(300).nullable().optional(), staffAdd: z.boolean().default(false), sortOrder: z.number().int().min(0).max(9999).default(0), ...ruleSchema });

/** The library for those who manage it (every folder) or add to it (folders open to teachers). */
export const library = async (userId: string) => {
    const v = await viewerOf(userId);
    const { rows, byId } = await loadFolders();
    const counts = await db.uploadItem.groupBy({ by: ['folderId', 'status'], _count: { _all: true } });
    const out = [];
    for (const f of rows) {
        if (!v.manage && !f.staffAdd) continue;
        const rule = folderRule(f as FolderRow, byId);
        out.push({ id: f.id, parentId: f.parentId, name: f.name, description: f.description, staffAdd: f.staffAdd, sortOrder: f.sortOrder, inherit: f.inherit, audience: f.audience, roleSlugs: f.roleSlugs, sectionIds: f.sectionIds, userIds: f.userIds, withParents: f.withParents, who: await describe(rule), files: counts.filter((c) => c.folderId === f.id).reduce((a, c) => a + c._count._all, 0), pending: counts.find((c) => c.folderId === f.id && c.status === 'pending')?._count._all ?? 0 });
    }
    const roles = await db.role.findMany({ where: { slug: { not: 'super-admin' } }, orderBy: { name: 'asc' }, select: { slug: true, name: true } });
    return { folders: out, roles, manage: v.manage, mySections: v.sections };
};

export const saveFolder = async (id: string | null, input: z.infer<typeof folderSchema>, userId: string) => {
    if (input.parentId && id && input.parentId === id) throw badRequest('A folder can’t be inside itself');
    const data = { ...input, parentId: input.parentId ?? null, description: input.description || null };
    const f = id ? await db.uploadFolder.update({ where: { id }, data }) : await db.uploadFolder.create({ data: { ...data, tenantId: getTenantId()!, createdBy: userId } });
    await recordAudit({ action: id ? 'folder_changed' : 'folder_added', entity: 'upload_folder', entityId: f.id, changes: { name: f.name } });
    return { id: f.id };
};

export const deleteFolder = async (id: string) => {
    if (await db.uploadFolder.count({ where: { parentId: id, isActive: true } })) throw badRequest('Move or delete the folders inside it first');
    if (await db.uploadItem.count({ where: { folderId: id } })) throw badRequest('Delete or move its files first');
    await db.uploadFolder.delete({ where: { id } });
    return { deleted: true };
};

// ─── Files ───────────────────────────────────────────────────────────────────

/** The files of a folder, for those who manage it (all) or add to it (theirs). */
export const folderItems = async (folderId: string, userId: string) => {
    const v = await viewerOf(userId);
    const folder = await db.uploadFolder.findFirst({ where: { id: folderId } });
    if (!folder) throw notFound('Folder not found');
    if (!v.manage && !folder.staffAdd) throw forbidden();
    const { byId } = await loadFolders();
    const items = await db.uploadItem.findMany({ where: { folderId, ...(v.manage ? {} : { OR: [{ uploadedBy: userId }, { status: 'published' }] }) }, orderBy: { createdAt: 'desc' } });
    const [users, tags] = await Promise.all([db.user.findMany({ where: { id: { in: items.map((i) => i.uploadedBy!).filter(Boolean) } }, select: { id: true, displayName: true } }), db.masterValue.findMany({ where: { master: 'upload_tag' }, select: { id: true, name: true } })]);
    const out = [];
    for (const i of items) {
        const acks = i.needsAck ? await db.uploadView.count({ where: { itemId: i.id, acknowledgedAt: { not: null } } }) : 0;
        const opened = await db.uploadView.count({ where: { itemId: i.id, opens: { gt: 0 } } });
        out.push({ id: i.id, title: i.title, description: i.description, kind: i.kind, link: i.link, fileName: i.fileName, mimeType: i.mimeType, sizeBytes: i.sizeBytes, version: i.version, tags: i.tagIds.map((t) => tags.find((x) => x.id === t)?.name).filter(Boolean), tagIds: i.tagIds, inherit: i.inherit, audience: i.audience, roleSlugs: i.roleSlugs, sectionIds: i.sectionIds, userIds: i.userIds, withParents: i.withParents, who: await describe(itemRule(i, byId)), validUntil: i.validUntil ? isoOf(i.validUntil) : null, expired: !!i.validUntil && isoOf(i.validUntil) < todayIST(), needsAck: i.needsAck, acks, opened, status: i.status, uploadedBy: users.find((u) => u.id === i.uploadedBy)?.displayName ?? null, mine: i.uploadedBy === userId, createdAt: i.createdAt, canEdit: v.manage || i.uploadedBy === userId });
    }
    return out;
};

/** A file sent from the screen: checked against the allowed types. */
export const acceptedKinds = async () => (await getSettings({ types: SHARED.types })).types as ('pdf' | 'docx' | 'xlsx' | 'pptx' | 'png' | 'jpeg' | 'webp' | 'gif' | 'mp4')[];

export const itemSchema = z
    .strictObject({
        folderId: z.uuid(),
        title: z.string().trim().min(1, 'is required').max(200),
        description: z.string().trim().max(1000).nullable().optional(),
        tagIds: z.array(z.uuid()).max(10).default([]),
        kind: z.enum(['file', 'link']),
        fileId: z.uuid().nullable().optional(),
        link: z.string().trim().max(500).nullable().optional(),
        validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        needsAck: z.boolean().default(false),
        notify: z.boolean().default(false),
        ...ruleSchema,
    })
    .refine((x) => (x.kind === 'file' ? !!x.fileId : !!x.link && /^https?:\/\//.test(x.link)), { message: 'choose a file, or give a link starting with https://', path: ['fileId'] });

/** Teachers (not managers) share only with the sections they teach, into folders open to them. */
const teacherLimits = async (v: Viewer, folderId: string, input: { audience: string; sectionIds: string[]; inherit: boolean }) => {
    if (v.manage) return;
    if (!v.add) throw forbidden();
    const folder = await db.uploadFolder.findFirst({ where: { id: folderId } });
    if (!folder?.staffAdd) throw forbidden('Teachers can’t add files to this folder');
    if (input.inherit || input.audience !== 'custom' || !input.sectionIds.length || input.sectionIds.some((s) => !v.sections.includes(s))) throw badRequest('Choose which of your sections can see it', [{ field: 'sectionIds', message: 'choose your sections' }]);
};

const notifyAudience = async (itemId: string) => {
    const i = await db.uploadItem.findFirst({ where: { id: itemId }, include: { folder: { select: { name: true } } } });
    if (!i || i.status !== 'published') return;
    const { byId } = await loadFolders();
    const users = await audienceUsers(itemRule(i, byId));
    if (users.length) raiseLater('shared_new', { audience: () => usersOf(users) }, { title: i.title, folder: i.folder.name, ack: i.needsAck ? 'Please open it and confirm you have read it.' : '' }, { dedupe: `shared-new:${itemId}:${i.version}` });
};

export const addItem = async (input: z.infer<typeof itemSchema>, userId: string) => {
    const v = await viewerOf(userId);
    await teacherLimits(v, input.folderId, input);
    const file = input.kind === 'file' ? await db.file.findFirst({ where: { id: input.fileId! }, select: { originalName: true, mimeType: true, sizeBytes: true } }) : null;
    if (input.kind === 'file' && !file) throw badRequest('Upload the file again');
    const { approval } = await getSettings({ approval: SHARED.teachersApproval });
    const status = !v.manage && approval ? 'pending' : 'published';
    const { notify, ...rest } = input;
    const i = await db.uploadItem.create({ data: { ...rest, tenantId: getTenantId()!, description: rest.description || null, fileId: rest.kind === 'file' ? rest.fileId! : null, link: rest.kind === 'link' ? rest.link! : null, fileName: file?.originalName ?? null, mimeType: file?.mimeType ?? null, sizeBytes: file?.sizeBytes ?? null, validUntil: rest.validUntil ? dayDate(rest.validUntil) : null, status, uploadedBy: userId } });
    if (notify && status === 'published') await notifyAudience(i.id);
    await recordAudit({ action: 'file_shared', entity: 'upload_item', entityId: i.id, changes: { title: i.title, status } });
    return { id: i.id, status };
};

export const editSchema = z.strictObject({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(1000).nullable().optional(), tagIds: z.array(z.uuid()).max(10).default([]), folderId: z.uuid(), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), needsAck: z.boolean().default(false), ...ruleSchema });

const own = async (id: string, userId: string) => {
    const i = await db.uploadItem.findFirst({ where: { id } });
    if (!i) throw notFound('File not found');
    const v = await viewerOf(userId);
    if (!v.manage && i.uploadedBy !== userId) throw forbidden();
    return { i, v };
};

export const editItem = async (id: string, input: z.infer<typeof editSchema>, userId: string) => {
    const { v } = await own(id, userId);
    await teacherLimits(v, input.folderId, input);
    await db.uploadItem.update({ where: { id }, data: { ...input, description: input.description || null, validUntil: input.validUntil ? dayDate(input.validUntil) : null } });
    return { id };
};

export const versionSchema = z.strictObject({ fileId: z.uuid().nullable().optional(), link: z.string().trim().max(500).nullable().optional(), notify: z.boolean().default(false) });
/** A new version of a file (the old one kept in the history, if set). */
export const newVersion = async (id: string, input: z.infer<typeof versionSchema>, userId: string) => {
    const { i } = await own(id, userId);
    const file = input.fileId ? await db.file.findFirst({ where: { id: input.fileId }, select: { originalName: true, mimeType: true, sizeBytes: true } }) : null;
    if (i.kind === 'file' ? !file : !input.link) throw badRequest(i.kind === 'file' ? 'Upload the new file' : 'Give the new link');
    const { keep } = await getSettings({ keep: SHARED.keepVersions });
    if (keep) await db.uploadVersion.create({ data: { tenantId: getTenantId()!, itemId: id, version: i.version, fileId: i.fileId, link: i.link, fileName: i.fileName, uploadedBy: i.uploadedBy } });
    await db.uploadItem.update({ where: { id }, data: { version: i.version + 1, ...(i.kind === 'file' ? { fileId: input.fileId!, fileName: file!.originalName, mimeType: file!.mimeType, sizeBytes: file!.sizeBytes } : { link: input.link! }) } });
    // A new version needs a new acknowledgement.
    if (i.needsAck) await db.uploadView.updateMany({ where: { itemId: id }, data: { acknowledgedAt: null, remindedAt: null } });
    if (input.notify) await notifyAudience(id);
    return { version: i.version + 1 };
};

export const deleteItem = async (id: string, userId: string) => {
    const { i } = await own(id, userId);
    await db.uploadItem.delete({ where: { id } });
    await recordAudit({ action: 'file_deleted', entity: 'upload_item', entityId: id, changes: { title: i.title } });
    return { deleted: true };
};

export const approveItem = async (id: string, approve: boolean, userId: string) => {
    const v = await viewerOf(userId);
    if (!v.manage) throw forbidden();
    if (approve) {
        await db.uploadItem.update({ where: { id }, data: { status: 'published' } });
        await notifyAudience(id);
    } else await db.uploadItem.delete({ where: { id } });
    return { approved: approve };
};

/** Who opened a file, who acknowledged it, and (for files to acknowledge) who hasn't yet. */
export const tracking = async (id: string) => {
    const i = await db.uploadItem.findFirst({ where: { id }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!i) throw notFound('File not found');
    const { byId } = await loadFolders();
    const [views, audience] = await Promise.all([db.uploadView.findMany({ where: { itemId: id }, orderBy: { lastAt: 'desc' } }), audienceUsers(itemRule(i, byId))]);
    const users = await db.user.findMany({ where: { id: { in: [...new Set([...views.map((x) => x.userId), ...(i.needsAck ? audience : [])])] } }, select: { id: true, displayName: true, kind: true } });
    const name = (u: string) => users.find((x) => x.id === u)?.displayName ?? '';
    const kind = (u: string) => users.find((x) => x.id === u)?.kind ?? '';
    const acked = new Set(views.filter((x) => x.acknowledgedAt).map((x) => x.userId));
    return {
        title: i.title,
        version: i.version,
        needsAck: i.needsAck,
        audience: audience.length,
        opened: views.filter((x) => x.opens > 0).length,
        acknowledged: acked.size,
        views: views.filter((x) => x.opens > 0 || x.acknowledgedAt).map((x) => ({ name: name(x.userId), kind: kind(x.userId), opens: x.opens, lastAt: x.lastAt, acknowledgedAt: x.acknowledgedAt })),
        notYet: i.needsAck ? audience.filter((u) => !acked.has(u)).slice(0, 500).map((u) => ({ name: name(u), kind: kind(u) })).sort((a, b) => a.name.localeCompare(b.name)) : [],
        versions: i.versions.map((x) => ({ version: x.version, fileName: x.fileName, link: x.link, at: x.at })),
    };
};

// ─── Downloads ───────────────────────────────────────────────────────────────

/** What a person may see: the folders and their files (published, not expired), with what is new and what to acknowledge. */
export const downloads = async (userId: string, search?: string) => {
    const v = await viewerOf(userId);
    const { rows, byId } = await loadFolders();
    const { newDays } = await getSettings({ newDays: SHARED.newDays });
    const today = dayDate(todayIST());
    const folders = rows.filter((f) => allows(folderRule(f as FolderRow, byId), v));
    const items = await db.uploadItem.findMany({ where: { folderId: { in: folders.map((f) => f.id) }, status: 'published', OR: [{ validUntil: null }, { validUntil: { gte: today } }], ...(search ? { AND: [{ OR: [{ title: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }, { fileName: { contains: search, mode: 'insensitive' } }] }] } : {}) }, orderBy: { updatedAt: 'desc' } });
    const visible = items.filter((i) => allows(itemRule(i, byId), v));
    const [mine, tags] = await Promise.all([db.uploadView.findMany({ where: { userId, itemId: { in: visible.map((i) => i.id) } } }), db.masterValue.findMany({ where: { master: 'upload_tag' }, select: { id: true, name: true } })]);
    const since = Date.now() - newDays * DAY;
    return {
        folders: folders
            .map((f) => ({
                id: f.id,
                parentId: f.parentId,
                name: f.name,
                description: f.description,
                items: visible
                    .filter((i) => i.folderId === f.id)
                    .map((i) => {
                        const seen = mine.find((m) => m.itemId === i.id);
                        return { id: i.id, title: i.title, description: i.description, kind: i.kind, link: i.link, fileName: i.fileName, mimeType: i.mimeType, sizeBytes: i.sizeBytes, version: i.version, tags: i.tagIds.map((t) => tags.find((x) => x.id === t)?.name).filter(Boolean), validUntil: i.validUntil ? isoOf(i.validUntil) : null, isNew: i.updatedAt.getTime() >= since && !seen?.opens, needsAck: i.needsAck, acknowledged: !!seen?.acknowledgedAt, updatedAt: i.updatedAt };
                    }),
            }))
            .filter((f) => f.items.length || !search),
        toAcknowledge: visible.filter((i) => i.needsAck && !mine.find((m) => m.itemId === i.id)?.acknowledgedAt).length,
    };
};

/** Opens a file the person may see (or the manager / uploader), and counts it. */
export const openItem = async (id: string, userId: string) => {
    const i = await db.uploadItem.findFirst({ where: { id } });
    if (!i) throw notFound('File not found');
    const v = await viewerOf(userId);
    if (!v.manage && i.uploadedBy !== userId) {
        const { byId } = await loadFolders();
        if (i.status !== 'published' || (i.validUntil && isoOf(i.validUntil) < todayIST()) || !allows(folderRule(byId.get(i.folderId), byId), v) || !allows(itemRule(i, byId), v)) throw forbidden();
    }
    await db.uploadView.upsert({ where: { itemId_userId: { itemId: id, userId } }, create: { tenantId: getTenantId()!, itemId: id, userId }, update: { lastAt: new Date(), opens: { increment: 1 } } });
    return i;
};

/** An earlier version (managers and the uploader). */
export const versionFile = async (itemId: string, version: number, userId: string) => {
    await own(itemId, userId);
    const x = await db.uploadVersion.findFirst({ where: { itemId, version } });
    if (!x?.fileId) throw notFound('Version not found');
    return x.fileId;
};

export const acknowledge = async (id: string, userId: string) => {
    await openItem(id, userId);
    await db.uploadView.update({ where: { itemId_userId: { itemId: id, userId } }, data: { acknowledgedAt: new Date() } });
    return { acknowledged: true };
};

// Reminders to acknowledge (once per person), some days after the file was shared.
defineDailyJob({
    key: 'shared_ack_reminder',
    run: async () => {
        const { days } = await getSettings({ days: SHARED.ackRemindDays });
        if (!days) return 'off';
        const items = await db.uploadItem.findMany({ where: { needsAck: true, status: 'published', updatedAt: { lte: new Date(Date.now() - days * DAY) }, OR: [{ validUntil: null }, { validUntil: { gte: dayDate(todayIST()) } }] }, include: { folder: { select: { name: true } } } });
        const { byId } = await loadFolders();
        let n = 0;
        for (const i of items) {
            const [audience, views] = await Promise.all([audienceUsers(itemRule(i, byId)), db.uploadView.findMany({ where: { itemId: i.id }, select: { userId: true, acknowledgedAt: true, remindedAt: true } })]);
            const left = audience.filter((u) => !views.find((x) => x.userId === u)?.acknowledgedAt && !views.find((x) => x.userId === u)?.remindedAt);
            if (!left.length) continue;
            raiseLater('shared_ack_reminder', { audience: () => usersOf(left) }, { title: i.title, folder: i.folder.name }, { dedupe: `shared-ack:${i.id}:${i.version}` });
            for (const u of left) await db.uploadView.upsert({ where: { itemId_userId: { itemId: i.id, userId: u } }, create: { tenantId: getTenantId()!, itemId: i.id, userId: u, opens: 0, remindedAt: new Date() }, update: { remindedAt: new Date() } });
            n += left.length;
        }
        return `${n} reminded`;
    },
});
