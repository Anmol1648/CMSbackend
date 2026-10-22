import type { Notice } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { NOTICES } from './notices.settings';
import { Audience, audienceFields, describeAudience, hasAudience, meantFor, membersOf, pickAudience, population, viewerOf } from './audience';

/**
 * Notices and circulars: written (draft), sent for approval when the school wants that, published
 * (now or at a set time) to some or all of the school, read and acknowledged.
 */

const DAY = 86_400_000;
const isLive = (n: Notice, now = new Date()) => n.status === 'published' && !!n.publishAt && n.publishAt <= now;
const expired = (n: Notice) => !!n.expiresOn && isoOf(n.expiresOn) < todayIST();

const names = async (ids: (string | null)[]) =>
    new Map((await db.user.findMany({ where: { id: { in: [...new Set(ids.filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
const categories = async () => new Map((await db.masterValue.findMany({ where: { master: 'notice_category' }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
const filesOf = async (ids: string[]) => (ids.length ? (await db.file.findMany({ where: { id: { in: ids } }, select: { id: true, originalName: true, mimeType: true } })).map((f) => ({ id: f.id, name: f.originalName, type: f.mimeType })) : []);

const powers = async (userId: string) => {
    const a = await getUserAccess(userId);
    return { write: !!a.permissions['notice.create'] || !!a.permissions['notice.publish'], publish: !!a.permissions['notice.publish'], reports: !!a.permissions['notice.reports'] || !!a.permissions['notice.publish'] };
};

// ─── Reading (everyone) ──────────────────────────────────────────────────────

export const listQuery = z.object({ archive: z.enum(['0', '1']).default('0'), category: z.uuid().optional(), search: z.string().trim().max(60).optional() });

/** The notices meant for the person: current ones (important first), or the archive of expired ones. */
export const myNotices = async (q: z.infer<typeof listQuery>, userId: string) => {
    const v = await viewerOf(userId);
    const { archiveDays } = await getSettings({ archiveDays: NOTICES.archiveDays });
    const today = todayIST();
    const archive = q.archive === '1';
    const rows = await db.notice.findMany({
        where: {
            status: 'published',
            publishAt: { lte: new Date() },
            ...(archive ? { expiresOn: { lt: dayDate(today), gte: new Date(Date.now() - archiveDays * DAY) } } : { OR: [{ expiresOn: null }, { expiresOn: { gte: dayDate(today) } }] }),
            ...(q.category ? { categoryId: q.category } : {}),
            ...(q.search ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { body: { contains: q.search, mode: 'insensitive' } }] } : {}),
        },
        orderBy: [{ important: 'desc' }, { publishAt: 'desc' }],
        take: 300,
    });
    const mine = rows.filter((n) => meantFor(n, v));
    const [reads, cats, by] = await Promise.all([db.noticeRead.findMany({ where: { userId, noticeId: { in: mine.map((n) => n.id) } } }), categories(), names(mine.map((n) => n.publishedBy))]);
    const readOf = new Map(reads.map((r) => [r.noticeId, r]));
    return mine.map((n) => ({
        id: n.id,
        title: n.title,
        excerpt: n.body.replace(/\*\*/g, '').slice(0, 220),
        category: n.categoryId ? (cats.get(n.categoryId) ?? null) : null,
        important: n.important,
        publishAt: n.publishAt,
        expiresOn: n.expiresOn ? isoOf(n.expiresOn) : null,
        by: n.publishedBy ? (by.get(n.publishedBy) ?? null) : null,
        attachments: n.attachmentIds.length,
        needsAck: n.needsAck,
        read: readOf.has(n.id),
        acknowledged: !!readOf.get(n.id)?.acknowledgedAt,
    }));
};

/** How many current notices the person hasn't opened (the number on the menu). */
export const unreadCount = async (userId: string) => {
    const list = await myNotices({ archive: '0' }, userId);
    return { unread: list.filter((n) => !n.read).length, toAcknowledge: list.filter((n) => n.needsAck && !n.acknowledged).length };
};

const loadNotice = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Notice not found');
    const n = await db.notice.findFirst({ where: { id } });
    if (!n) throw notFound('Notice not found');
    return n;
};

/** Opens a notice (and records that the person has read it). Writers can open any, drafts too. */
export const openNotice = async (id: string, userId: string) => {
    const n = await loadNotice(id);
    const p = await powers(userId);
    const meant = isLive(n) && meantFor(n, await viewerOf(userId));
    if (!meant && !p.write) throw notFound('Notice not found');
    if (meant) await db.noticeRead.upsert({ where: { noticeId_userId: { noticeId: id, userId } }, create: { tenantId: getTenantId()!, noticeId: id, userId }, update: {} });
    const [cats, by, files, read] = await Promise.all([categories(), names([n.publishedBy, n.createdBy]), filesOf(n.attachmentIds), db.noticeRead.findFirst({ where: { noticeId: id, userId } })]);
    return {
        id: n.id,
        title: n.title,
        body: n.body,
        category: n.categoryId ? (cats.get(n.categoryId) ?? null) : null,
        important: n.important,
        status: n.status,
        publishAt: n.publishAt,
        expiresOn: n.expiresOn ? isoOf(n.expiresOn) : null,
        by: n.publishedBy ? (by.get(n.publishedBy) ?? null) : n.createdBy ? (by.get(n.createdBy) ?? null) : null,
        audience: await describeAudience(n),
        attachments: files,
        needsAck: n.needsAck,
        meantForMe: meant,
        acknowledgedAt: read?.acknowledgedAt ?? null,
    };
};

/** "I have read this". */
export const acknowledge = async (id: string, userId: string) => {
    const n = await loadNotice(id);
    if (!isLive(n) || !meantFor(n, await viewerOf(userId))) throw notFound('Notice not found');
    if (!n.needsAck) throw badRequest('This notice doesn’t ask for it');
    await db.noticeRead.upsert({ where: { noticeId_userId: { noticeId: id, userId } }, create: { tenantId: getTenantId()!, noticeId: id, userId, acknowledgedAt: new Date() }, update: { acknowledgedAt: new Date() } });
    return openNotice(id, userId);
};

/** An attachment of a notice the person may see. */
export const attachmentOf = async (id: string, fileId: string, userId: string) => {
    const n = await loadNotice(id);
    if (!n.attachmentIds.includes(fileId)) throw notFound('Attachment not found');
    const p = await powers(userId);
    if (!p.write && !(isLive(n) && meantFor(n, await viewerOf(userId)))) throw notFound('Notice not found');
    return fileId;
};

// ─── Writing (the office) ────────────────────────────────────────────────────

const MAX_BODY = 20_000;
export const noticeSchema = z
    .strictObject({
        title: z.string().trim().min(3, 'is too short').max(160),
        body: z.string().trim().min(3, 'is too short').max(MAX_BODY),
        categoryId: z.uuid().nullable().optional(),
        important: z.boolean().default(false),
        /** A time to publish at (scheduled); empty = when published. */
        publishAt: z.iso.datetime({ offset: true }).nullable().optional(),
        expiresOn: z.iso.date().nullable().optional(),
        needsAck: z.boolean().optional(),
        attachmentIds: z.array(z.uuid()).max(10).default([]),
        ...audienceFields,
    })
    .refine(hasAudience, { message: 'choose who it is for', path: ['forEveryone'] })
    .refine((x) => !x.expiresOn || x.expiresOn >= todayIST(), { message: 'is in the past', path: ['expiresOn'] });
type NoticeInput = z.infer<typeof noticeSchema>;

const checkFiles = async (ids: string[], keep: string[] = []) => {
    const fresh = ids.filter((x) => !keep.includes(x));
    if (fresh.length && (await db.file.count({ where: { id: { in: fresh }, purpose: 'document' } })) !== fresh.length) throw badRequest('Upload the attachments again', [{ field: 'attachmentIds', message: 'are not uploads' }]);
};

const dataOf = async (input: NoticeInput) => {
    const { ackDefault } = await getSettings({ ackDefault: NOTICES.ackDefault });
    return {
        title: input.title,
        body: input.body,
        categoryId: input.categoryId ?? null,
        important: input.important,
        expiresOn: input.expiresOn ? dayDate(input.expiresOn) : null,
        needsAck: input.needsAck ?? ackDefault,
        attachmentIds: input.attachmentIds,
        ...pickAudience(input),
    };
};

export const createNotice = async (input: NoticeInput, userId: string) => {
    if (!(await powers(userId)).write) throw forbidden();
    await checkFiles(input.attachmentIds);
    const n = await db.notice.create({ data: { tenantId: getTenantId()!, ...(await dataOf(input)), publishAt: input.publishAt ? new Date(input.publishAt) : null } });
    await recordAudit({ action: 'notice_created', entity: 'notice', entityId: n.id, changes: { title: n.title } });
    return manageOne(n.id);
};

export const updateNotice = async (id: string, input: NoticeInput, userId: string) => {
    const n = await loadNotice(id);
    const p = await powers(userId);
    if (!p.write) throw forbidden();
    // A published notice can be corrected only by those who may publish (its readers already saw it).
    if (n.status === 'published' && !p.publish && n.createdBy !== userId) throw forbidden('Only the principal (or who wrote it) can change a published notice');
    await checkFiles(input.attachmentIds, n.attachmentIds);
    await db.notice.update({ where: { id }, data: { ...(await dataOf(input)), ...(input.publishAt !== undefined ? { publishAt: input.publishAt ? new Date(input.publishAt) : n.status === 'published' ? n.publishAt : null } : {}) } });
    await recordAudit({ action: 'notice_updated', entity: 'notice', entityId: id, changes: { title: input.title } });
    return manageOne(id);
};

/** Publishes (now or at its set time), or sends it for approval when the school asks for that. */
export const publishNotice = async (id: string, userId: string) => {
    const n = await loadNotice(id);
    const p = await powers(userId);
    if (!p.write) throw forbidden();
    if (n.status === 'published') throw badRequest('It is already published');
    const { approval } = await getSettings({ approval: NOTICES.approval });
    if (approval && !p.publish) {
        await db.notice.update({ where: { id }, data: { status: 'pending', submittedBy: userId } });
        await recordAudit({ action: 'notice_sent_for_approval', entity: 'notice', entityId: id, changes: { title: n.title } });
        return manageOne(id);
    }
    const at = n.publishAt && n.publishAt > new Date() ? n.publishAt : new Date();
    await db.notice.update({ where: { id }, data: { status: 'published', publishAt: at, publishedBy: userId, publishedAt: new Date() } });
    await recordAudit({ action: 'notice_published', entity: 'notice', entityId: id, changes: { title: n.title } });
    return manageOne(id);
};

/** Back to draft: a pending one sent back, or a published one taken off the board. */
export const unpublishNotice = async (id: string, userId: string) => {
    const n = await loadNotice(id);
    const p = await powers(userId);
    if (!p.publish && !(p.write && (n.status === 'pending' || n.createdBy === userId))) throw forbidden();
    await db.notice.update({ where: { id }, data: { status: 'draft' } });
    await recordAudit({ action: n.status === 'pending' ? 'notice_sent_back' : 'notice_unpublished', entity: 'notice', entityId: id, changes: { title: n.title } });
    return manageOne(id);
};

export const deleteNotice = async (id: string, userId: string) => {
    const n = await loadNotice(id);
    const p = await powers(userId);
    if (!p.publish && !(p.write && n.status !== 'published' && n.createdBy === userId)) throw forbidden('Only the principal can delete a published notice, or the writer their draft');
    await db.notice.delete({ where: { id } });
    await recordAudit({ action: 'notice_deleted', entity: 'notice', entityId: id, changes: { title: n.title } });
};

// ─── The office's list and read counts ───────────────────────────────────────

export const manageQuery = z.object({ status: z.enum(['all', 'draft', 'pending', 'scheduled', 'published', 'expired']).default('all'), search: z.string().trim().max(60).optional() });

const manageRows = async (rows: Notice[]) => {
    const [cats, by, everyone, reads] = await Promise.all([
        categories(),
        names(rows.flatMap((n) => [n.createdBy, n.publishedBy, n.submittedBy])),
        population(),
        db.noticeRead.groupBy({ by: ['noticeId'], where: { noticeId: { in: rows.map((n) => n.id) } }, _count: { _all: true, acknowledgedAt: true } }),
    ]);
    const now = new Date();
    return Promise.all(
        rows.map(async (n) => {
            const r = reads.find((x) => x.noticeId === n.id);
            const state = n.status !== 'published' ? n.status : expired(n) ? 'expired' : n.publishAt && n.publishAt > now ? 'scheduled' : 'published';
            return {
                id: n.id,
                title: n.title,
                category: n.categoryId ? (cats.get(n.categoryId) ?? null) : null,
                important: n.important,
                state,
                publishAt: n.publishAt,
                expiresOn: n.expiresOn ? isoOf(n.expiresOn) : null,
                audience: await describeAudience(n),
                audienceCount: membersOf(n, everyone).length,
                readCount: r?._count._all ?? 0,
                ackCount: r?._count.acknowledgedAt ?? 0,
                needsAck: n.needsAck,
                writtenBy: n.createdBy ? (by.get(n.createdBy) ?? null) : null,
                sentBy: n.submittedBy ? (by.get(n.submittedBy) ?? null) : null,
                publishedBy: n.publishedBy ? (by.get(n.publishedBy) ?? null) : null,
            };
        })
    );
};

export const manageNotices = async (q: z.infer<typeof manageQuery>, userId: string) => {
    if (!(await powers(userId)).write) throw forbidden();
    const today = dayDate(todayIST());
    const now = new Date();
    const where =
        q.status === 'draft' || q.status === 'pending'
            ? { status: q.status }
            : q.status === 'scheduled'
              ? { status: 'published', publishAt: { gt: now } }
              : q.status === 'published'
                ? { status: 'published', publishAt: { lte: now }, OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] }
                : q.status === 'expired'
                  ? { status: 'published', expiresOn: { lt: today } }
                  : {};
    const rows = await db.notice.findMany({ where: { ...where, ...(q.search ? { title: { contains: q.search, mode: 'insensitive' as const } } : {}) }, orderBy: [{ updatedAt: 'desc' }], take: 200 });
    return manageRows(rows);
};

/** One notice for its editor (all fields). */
export const manageOne = async (id: string) => {
    const n = await loadNotice(id);
    const [row] = await manageRows([n]);
    return { ...row, body: n.body, categoryId: n.categoryId, ...pickAudience(n), attachments: await filesOf(n.attachmentIds), attachmentIds: n.attachmentIds };
};

/** Who it is for, and who has read / acknowledged it, group by group (Staff, VII-B parents…). */
export const readers = async (id: string, userId: string) => {
    const n = await loadNotice(id);
    if (!(await powers(userId)).reports && n.createdBy !== userId) throw forbidden();
    const members = membersOf(n as Audience, await population());
    const reads = new Map((await db.noticeRead.findMany({ where: { noticeId: id } })).map((r) => [r.userId, r]));
    const groups = new Map<string, { group: string; people: { name: string; readAt: Date | null; acknowledgedAt: Date | null }[] }>();
    for (const m of members) {
        const g = groups.get(m.group) ?? { group: m.group, people: [] };
        const r = reads.get(m.userId);
        g.people.push({ name: m.name, readAt: r?.readAt ?? null, acknowledgedAt: r?.acknowledgedAt ?? null });
        groups.set(m.group, g);
    }
    const list = [...groups.values()].sort((a, b) => (a.group === 'Staff' ? -1 : b.group === 'Staff' ? 1 : a.group.localeCompare(b.group, 'en', { numeric: true })));
    for (const g of list) g.people.sort((a, b) => Number(!!b.readAt) - Number(!!a.readAt) || a.name.localeCompare(b.name));
    return {
        title: n.title,
        needsAck: n.needsAck,
        total: members.length,
        read: members.filter((m) => reads.has(m.userId)).length,
        acknowledged: members.filter((m) => reads.get(m.userId)?.acknowledgedAt).length,
        groups: list.map((g) => ({ ...g, read: g.people.filter((p) => p.readAt).length })),
    };
};
