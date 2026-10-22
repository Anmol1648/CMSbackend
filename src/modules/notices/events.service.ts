import type { SchoolEvent } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getUserAccess } from '../rbac/access.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { audienceFields, describeAudience, hasAudience, meantFor, pickAudience, viewerOf } from './audience';

/**
 * The school calendar: events (PTM, sports day, exams, trips…) for some or all of the school, with
 * the holiday list. An event can make its days holidays, and post a notice about itself.
 */

const ISO = z.iso.date();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 09:30');
const DAY = 86_400_000;
const show = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const mayManage = async (userId: string) => !!(await getUserAccess(userId)).permissions['event.manage'];
const types = async () => new Map((await db.masterValue.findMany({ where: { master: 'event_type' }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));

const present = async (e: SchoolEvent, typeNames: Map<string, string>) => ({
    kind: 'event' as const,
    id: e.id,
    title: e.title,
    type: e.typeId ? (typeNames.get(e.typeId) ?? null) : null,
    typeId: e.typeId,
    from: isoOf(e.startDate),
    to: isoOf(e.endDate),
    startTime: e.startTime,
    endTime: e.endTime,
    venue: e.venue,
    description: e.description,
    holidayFor: e.holidayFor,
    status: e.status,
    audience: await describeAudience(e),
    ...pickAudience(e),
    attachments: e.attachmentIds.length ? (await db.file.findMany({ where: { id: { in: e.attachmentIds } }, select: { id: true, originalName: true } })).map((f) => ({ id: f.id, name: f.originalName })) : [],
});

// ─── The calendar ────────────────────────────────────────────────────────────

export const calendarQuery = z.object({ from: ISO, to: ISO });

/** Events of a period meant for the person (all of them for those who manage events), and holidays. */
export const calendar = async (q: z.infer<typeof calendarQuery>, userId: string) => {
    if (q.from > q.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    if (dayDate(q.to).getTime() - dayDate(q.from).getTime() > 400 * DAY) throw badRequest('At most a year at a time');
    const [manager, v, rows, holidays, typeNames] = await Promise.all([
        mayManage(userId),
        viewerOf(userId),
        db.schoolEvent.findMany({ where: { startDate: { lte: dayDate(q.to) }, endDate: { gte: dayDate(q.from) } }, orderBy: [{ startDate: 'asc' }, { startTime: 'asc' }] }),
        db.holiday.findMany({ where: { date: { gte: dayDate(q.from), lte: dayDate(q.to) }, eventId: null }, orderBy: { date: 'asc' } }),
        types(),
    ]);
    const events = await Promise.all(rows.filter((e) => manager || meantFor(e, v)).map((e) => present(e, typeNames)));
    // Students and parents see the student holidays; staff the staff ones.
    const familyOnly = !v.staff && (v.student || v.parent);
    const offs = holidays
        .filter((h) => (familyOnly ? h.forStudents : manager || v.staff ? true : h.forStudents))
        .map((h) => ({ kind: 'holiday' as const, id: h.id, title: h.name, from: isoOf(h.date), to: isoOf(h.date), forStudents: h.forStudents, forStaff: h.forStaff }));
    return { from: q.from, to: q.to, canManage: manager, events, holidays: offs };
};

/** The next few events for the person (dashboard, notice board). */
export const upcoming = async (userId: string, days = 30) => {
    const from = todayIST();
    const to = isoOf(new Date(dayDate(from).getTime() + days * DAY));
    const c = await calendar({ from, to }, userId);
    return c.events.filter((e) => e.status === 'scheduled').slice(0, 10);
};

// ─── Managing ────────────────────────────────────────────────────────────────

export const eventSchema = z
    .strictObject({
        title: z.string().trim().min(3, 'is too short').max(120),
        typeId: z.uuid().nullable().optional(),
        from: ISO,
        to: ISO,
        startTime: HHMM.nullable().optional(),
        endTime: HHMM.nullable().optional(),
        venue: z.string().trim().max(120).nullable().optional(),
        description: z.string().trim().max(5000).nullable().optional(),
        holidayFor: z.enum(['none', 'students', 'staff', 'both']).default('none'),
        attachmentIds: z.array(z.uuid()).max(10).default([]),
        /** Also put a notice on the board about it (when adding). */
        postNotice: z.boolean().optional(),
        ...audienceFields,
    })
    .refine((x) => x.to >= x.from, { message: '“To” is before “from”', path: ['to'] })
    .refine((x) => !x.startTime || !x.endTime || x.from !== x.to || x.endTime > x.startTime, { message: 'is before the start', path: ['endTime'] })
    .refine(hasAudience, { message: 'choose who it is for', path: ['forEveryone'] })
    .refine((x) => dayDate(x.to).getTime() - dayDate(x.from).getTime() <= 120 * DAY, { message: 'at most 120 days', path: ['to'] });
type EventInput = z.infer<typeof eventSchema>;

const loadEvent = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Event not found');
    const e = await db.schoolEvent.findFirst({ where: { id } });
    if (!e) throw notFound('Event not found');
    return e;
};

/** The event's days become holidays (days already a holiday stay as they are). */
const syncHolidays = async (e: SchoolEvent) => {
    await withTransaction(async (tx) => {
        await tx.holiday.deleteMany({ where: { eventId: e.id } });
        if (e.holidayFor === 'none' || e.status === 'cancelled') return;
        const data = [];
        for (let t = e.startDate.getTime(); t <= e.endDate.getTime(); t += DAY)
            data.push({ tenantId: getTenantId()!, date: new Date(t), name: e.title, forStudents: e.holidayFor !== 'staff', forStaff: e.holidayFor !== 'students', eventId: e.id, isDemo: e.isDemo });
        await tx.holiday.createMany({ data, skipDuplicates: true });
    });
};

const dataOf = (input: EventInput) => ({
    title: input.title,
    typeId: input.typeId ?? null,
    startDate: dayDate(input.from),
    endDate: dayDate(input.to),
    startTime: input.startTime || null,
    endTime: input.endTime || null,
    venue: input.venue || null,
    description: input.description || null,
    holidayFor: input.holidayFor,
    attachmentIds: input.attachmentIds,
    ...pickAudience(input),
});

const when = (e: SchoolEvent) => {
    const a = isoOf(e.startDate);
    const b = isoOf(e.endDate);
    return `${a === b ? show(a) : `${show(a)} to ${show(b)}`}${e.startTime ? `, ${e.startTime}${e.endTime ? `–${e.endTime}` : ''}` : ''}`;
};

export const createEvent = async (input: EventInput, userId: string) => {
    if (!(await mayManage(userId))) throw forbidden();
    const e = await db.schoolEvent.create({ data: { tenantId: getTenantId()!, ...dataOf(input) } });
    await syncHolidays(e);
    if (input.postNotice) {
        const typeName = e.typeId ? (await types()).get(e.typeId) : null;
        const category = await db.masterValue.findFirst({ where: { master: 'notice_category', name: e.holidayFor !== 'none' ? 'Holiday notice' : 'Event', isActive: true }, select: { id: true } });
        await db.notice.create({
            data: {
                tenantId: getTenantId()!,
                title: e.title,
                body: [`**${when(e)}**`, e.venue ? `Venue: ${e.venue}` : null, typeName ? `(${typeName})` : null, '', e.description ?? '', e.holidayFor !== 'none' ? `The school is closed on ${isoOf(e.startDate) === isoOf(e.endDate) ? 'this day' : 'these days'}${e.holidayFor === 'students' ? ' for students' : e.holidayFor === 'staff' ? ' for staff' : ''}.` : null].filter((x) => x !== null).join('\n').trim(),
                categoryId: category?.id ?? null,
                status: 'published',
                publishAt: new Date(),
                publishedBy: userId,
                publishedAt: new Date(),
                expiresOn: e.endDate,
                eventId: e.id,
                attachmentIds: e.attachmentIds,
                ...pickAudience(e),
            },
        });
    }
    await recordAudit({ action: 'event_created', entity: 'school_event', entityId: e.id, changes: { title: e.title, from: input.from, to: input.to } });
    return present(e, await types());
};

export const updateEvent = async (id: string, input: EventInput, userId: string) => {
    if (!(await mayManage(userId))) throw forbidden();
    await loadEvent(id);
    const e = await db.schoolEvent.update({ where: { id }, data: dataOf(input) });
    await syncHolidays(e);
    await recordAudit({ action: 'event_updated', entity: 'school_event', entityId: id, changes: { title: e.title } });
    return present(e, await types());
};

/** Called off: stays on the calendar crossed out; its holidays go. */
export const setCancelled = async (id: string, cancelled: boolean, userId: string) => {
    if (!(await mayManage(userId))) throw forbidden();
    await loadEvent(id);
    const e = await db.schoolEvent.update({ where: { id }, data: { status: cancelled ? 'cancelled' : 'scheduled' } });
    await syncHolidays(e);
    await recordAudit({ action: cancelled ? 'event_cancelled' : 'event_restored', entity: 'school_event', entityId: id, changes: { title: e.title } });
    return present(e, await types());
};

export const deleteEvent = async (id: string, userId: string) => {
    if (!(await mayManage(userId))) throw forbidden();
    const e = await loadEvent(id);
    await withTransaction(async (tx) => {
        await tx.holiday.deleteMany({ where: { eventId: id } });
        await tx.schoolEvent.delete({ where: { id } });
    });
    await recordAudit({ action: 'event_deleted', entity: 'school_event', entityId: id, changes: { title: e.title } });
};

/** An attachment of an event the person may see. */
export const eventAttachment = async (id: string, fileId: string, userId: string) => {
    const e = await loadEvent(id);
    if (!e.attachmentIds.includes(fileId)) throw notFound('Attachment not found');
    if (!(await mayManage(userId)) && !meantFor(e, await viewerOf(userId))) throw notFound('Event not found');
    return fileId;
};
