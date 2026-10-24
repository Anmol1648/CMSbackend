import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { dayDate, isoOf, minutesIST, todayIST } from '../attendance/attendance.settings';
import { raiseLater } from '../alerts/deliver';
import { parentsOf, staffOf, studentsOf } from '../alerts/recipients';
import { PTM } from './ptm.settings';

/**
 * Parent–teacher meetings. A PTM is a day, a time window and some sections; the teachers who sit
 * are each section's class teacher (and its subject teachers, if the PTM says so). Each teacher's
 * day is cut into slots; parents book one slot per teacher per child, the desk checks them in, and
 * the teacher marks the meeting and writes remarks (which parents see after, if the school allows).
 */

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour time like 09:00');
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const showTime = (t: string) => {
    const m = mins(t);
    const h = Math.floor(m / 60);
    return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
export const showDay = (d: Date | string) => new Date(typeof d === 'string' ? `${d}T00:00:00Z` : d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const staffName = (s: { firstName: string; middleName?: string | null; lastName?: string | null }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

type PtmRow = { id: string; date: Date; startTime: string; endTime: string; slotMinutes: number; breakStart: string | null; breakEnd: string | null; whoSits: string; sectionIds: string[]; academicYearId: string };

/** The slots of a PTM ("09:00", "09:10"…), without the break. */
export const slotsOf = (p: Pick<PtmRow, 'startTime' | 'endTime' | 'slotMinutes' | 'breakStart' | 'breakEnd'>) => {
    const out: string[] = [];
    const bs = p.breakStart ? mins(p.breakStart) : null;
    const be = p.breakEnd ? mins(p.breakEnd) : null;
    for (let t = mins(p.startTime); t + p.slotMinutes <= mins(p.endTime); t += p.slotMinutes) {
        if (bs !== null && be !== null && t < be && t + p.slotMinutes > bs) continue;
        out.push(hhmm(t));
    }
    return out;
};

/** Who sits for each section of a PTM: the class teacher, and the subject teachers (with their subjects). */
export const sittingBySection = async (p: PtmRow) => {
    const [sections, teaching] = await Promise.all([
        db.section.findMany({ where: { id: { in: p.sectionIds } }, select: { id: true, classTeacherId: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } }),
        p.whoSits === 'class_subject' ? db.teachingAssignment.findMany({ where: { academicYearId: p.academicYearId, sectionId: { in: p.sectionIds } }, select: { sectionId: true, staffId: true, subject: { select: { name: true } } } }) : [],
    ]);
    const out = new Map<string, Map<string, { classTeacher: boolean; subjects: string[] }>>();
    for (const s of sections) {
        const m = new Map<string, { classTeacher: boolean; subjects: string[] }>();
        if (s.classTeacherId) m.set(s.classTeacherId, { classTeacher: true, subjects: [] });
        for (const t of teaching.filter((x) => x.sectionId === s.id)) {
            const cur = m.get(t.staffId) ?? { classTeacher: false, subjects: [] };
            cur.subjects.push(t.subject.name);
            m.set(t.staffId, cur);
        }
        out.set(s.id, m);
    }
    return { sections, bySection: out };
};

/** The PTM's teachers (one row each), made when it is published or opened. */
const ensureTeachers = async (p: PtmRow) => {
    const { bySection } = await sittingBySection(p);
    const ids = [...new Set([...bySection.values()].flatMap((m) => [...m.keys()]))];
    if (ids.length) await db.ptmTeacher.createMany({ data: ids.map((staffId) => ({ tenantId: getTenantId()!, ptmId: p.id, staffId })), skipDuplicates: true });
    return ids;
};

/** Students of some sections this session, with their section. */
const studentsIn = async (yearId: string, sectionIds: string[]) =>
    db.enrolment.findMany({ where: { academicYearId: yearId, sectionId: { in: sectionIds }, student: { status: 'active' } }, select: { sectionId: true, rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } }, orderBy: [{ rollNumber: 'asc' }] });

// ─── Planning ────────────────────────────────────────────────────────────────

export const ptmSchema = z
    .strictObject({
        title: z.string().trim().min(3, 'is required').max(120),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: TIME,
        endTime: TIME,
        slotMinutes: z.number().int().min(3).max(60),
        breakStart: TIME.nullable().optional(),
        breakEnd: TIME.nullable().optional(),
        mode: z.enum(['in_person', 'online', 'both']),
        whoSits: z.enum(['class', 'class_subject']),
        booking: z.boolean(),
        sectionIds: z.array(z.uuid()).min(1, 'choose at least one section').max(200),
        note: z.string().trim().max(1000).nullable().optional(),
    })
    .refine((p) => mins(p.endTime) > mins(p.startTime) + p.slotMinutes, { message: 'must be after the start (at least one slot)', path: ['endTime'] })
    .refine((p) => !p.breakStart === !p.breakEnd && (!p.breakStart || mins(p.breakEnd!) > mins(p.breakStart)), { message: 'give both break times, end after start', path: ['breakEnd'] });

/** What a new PTM starts with (System Settings → PTM). */
export const ptmDefaults = async () => {
    const s = await getSettings({ slot: PTM.slotMinutes, who: PTM.whoSits });
    return { slotMinutes: s.slot, whoSits: s.who };
};

export const listPtms = async () => {
    const rows = await db.ptm.findMany({ orderBy: { date: 'desc' }, take: 100 });
    const counts = await db.ptmMeeting.groupBy({ by: ['ptmId', 'status'], where: { ptmId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const n = (id: string, st: string[]) => counts.filter((c) => c.ptmId === id && st.includes(c.status)).reduce((a, c) => a + c._count._all, 0);
    return rows.map((p) => ({ id: p.id, title: p.title, date: isoOf(p.date), startTime: p.startTime, endTime: p.endTime, mode: p.mode, status: p.status, sections: p.sectionIds.length, booked: n(p.id, ['booked', 'waiting', 'attended', 'absent']), met: n(p.id, ['attended']), absent: n(p.id, ['absent']) }));
};

export const getPtm = async (id: string) => {
    const p = await db.ptm.findFirst({ where: { id } });
    if (!p) throw notFound('PTM not found');
    if (p.status !== 'draft') await ensureTeachers(p);
    const { sections, bySection } = await sittingBySection(p);
    const sitting = [...new Set([...bySection.values()].flatMap((m) => [...m.keys()]))];
    const [rows, staff, meetings, students] = await Promise.all([
        db.ptmTeacher.findMany({ where: { ptmId: id } }),
        db.staff.findMany({ where: { id: { in: sitting } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
        db.ptmMeeting.groupBy({ by: ['staffId', 'status'], where: { ptmId: id }, _count: { _all: true } }),
        db.enrolment.groupBy({ by: ['sectionId'], where: { academicYearId: p.academicYearId, sectionId: { in: p.sectionIds }, student: { status: 'active' } }, _count: { _all: true } }),
    ]);
    const slots = slotsOf(p);
    const n = (staffId: string, st: string[]) => meetings.filter((m) => m.staffId === staffId && st.includes(m.status)).reduce((a, m) => a + m._count._all, 0);
    return {
        ...p,
        date: isoOf(p.date),
        slots,
        sections: sections.sort((a, b) => a.schoolClass.sortOrder - b.schoolClass.sortOrder || a.sortOrder - b.sortOrder).map((s) => ({ id: s.id, label: sectionLabel(s), students: students.find((x) => x.sectionId === s.id)?._count._all ?? 0, classTeacher: s.classTeacherId ? staffName(staff.find((x) => x.id === s.classTeacherId) ?? { firstName: '—' }) : null })),
        teachers: staff
            .map((s) => {
                const r = rows.find((x) => x.staffId === s.id);
                const sectionsOf = sections.filter((sec) => bySection.get(sec.id)?.has(s.id));
                return {
                    staffId: s.id,
                    name: staffName(s),
                    sections: sectionsOf.map((sec) => `${sectionLabel(sec)}${bySection.get(sec.id)!.get(s.id)!.classTeacher ? ' (class teacher)' : ''}`),
                    subjects: [...new Set(sectionsOf.flatMap((sec) => bySection.get(sec.id)!.get(s.id)!.subjects))],
                    room: r?.room ?? null,
                    link: r?.link ?? null,
                    away: r?.away ?? false,
                    booked: n(s.id, ['booked', 'waiting', 'attended', 'absent']),
                    met: n(s.id, ['attended']),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        totals: { students: students.reduce((a, s) => a + s._count._all, 0), booked: meetings.filter((m) => m.status !== 'cancelled').reduce((a, m) => a + m._count._all, 0), met: meetings.filter((m) => m.status === 'attended').reduce((a, m) => a + m._count._all, 0) },
    };
};

export const savePtm = async (id: string | null, input: z.infer<typeof ptmSchema>, userId: string) => {
    const year = await currentYear();
    if (!year) throw badRequest('No current academic year');
    if (!id && input.date < todayIST()) throw badRequest('The date is in the past', [{ field: 'date', message: 'is in the past' }]);
    const found = await db.section.count({ where: { id: { in: input.sectionIds }, academicYearId: year.id } });
    if (found !== input.sectionIds.length) throw badRequest('Choose sections of this session', [{ field: 'sectionIds', message: 'has a section of another session' }]);
    const data = { ...input, date: dayDate(input.date), breakStart: input.breakStart || null, breakEnd: input.breakEnd || null, note: input.note || null };
    if (id) {
        const cur = await db.ptm.findFirst({ where: { id } });
        if (!cur) throw notFound('PTM not found');
        if (['done', 'cancelled'].includes(cur.status)) throw badRequest('This PTM is over; it can’t be changed');
        const booked = await db.ptmMeeting.count({ where: { ptmId: id, slot: { not: null }, status: { not: 'cancelled' } } });
        if (booked && (isoOf(cur.date) !== input.date || cur.startTime !== input.startTime || cur.endTime !== input.endTime || cur.slotMinutes !== input.slotMinutes || cur.breakStart !== data.breakStart || cur.breakEnd !== data.breakEnd))
            throw badRequest(`${booked} slot${booked === 1 ? ' is' : 's are'} booked: the date and times can’t change now (cancel the PTM and plan a new one)`);
        const p = await db.ptm.update({ where: { id }, data });
        if (p.status === 'published') await ensureTeachers(p);
        await recordAudit({ action: 'ptm_changed', entity: 'ptm', entityId: id, changes: { title: p.title } });
        return getPtm(id);
    }
    const p = await db.ptm.create({ data: { ...data, tenantId: getTenantId()!, academicYearId: year.id, createdBy: userId } });
    await recordAudit({ action: 'ptm_added', entity: 'ptm', entityId: p.id, changes: { title: p.title, date: input.date } });
    return getPtm(p.id);
};

export const teacherSchema = z.strictObject({ room: z.string().trim().max(60).nullable().optional(), link: z.string().trim().max(500).refine((u) => !u || /^https?:\/\//.test(u), 'must start with https://').nullable().optional(), away: z.boolean().default(false) });
export const setTeacher = async (ptmId: string, staffId: string, input: z.infer<typeof teacherSchema>) => {
    const p = await db.ptm.findFirst({ where: { id: ptmId } });
    if (!p) throw notFound('PTM not found');
    await ensureTeachers(p);
    await db.ptmTeacher.upsert({ where: { ptmId_staffId: { ptmId, staffId } }, create: { tenantId: getTenantId()!, ptmId, staffId, room: input.room || null, link: input.link || null, away: input.away }, update: { room: input.room || null, link: input.link || null, away: input.away } });
    return getPtm(ptmId);
};

const announceVars = async (p: { title: string; date: Date; startTime: string; endTime: string; booking: boolean; mode: string }) => {
    const { cutoff } = await getSettings({ cutoff: PTM.cutoffHours });
    return { title: p.title, date: showDay(p.date), time: `${showTime(p.startTime)} – ${showTime(p.endTime)}`, how: p.mode === 'online' ? 'online (the link is on the PTM page)' : p.mode === 'both' ? 'at school or online' : 'at school', booking: p.booking ? `Please book a time with each teacher on the PTM page${cutoff ? ` (until ${cutoff} hours before)` : ''}.` : 'No booking needed: come any time in these hours.' };
};

export const publishPtm = async (id: string, userId: string) => {
    const p = await db.ptm.findFirst({ where: { id } });
    if (!p) throw notFound('PTM not found');
    if (p.status !== 'draft') throw badRequest('Already published');
    const teachers = await ensureTeachers(p);
    if (!teachers.length) throw badRequest('No teacher sits for these sections (set class teachers / subject teachers first)');
    await db.ptm.update({ where: { id }, data: { status: 'published', publishedAt: new Date() } });
    const ids = (await studentsIn(p.academicYearId, p.sectionIds)).map((e) => e.student.id);
    raiseLater('ptm_announced', { parent: () => parentsOf(ids), student: () => studentsOf(ids), teacher: () => staffOf(teachers) }, await announceVars(p), { dedupe: `ptm-announce:${id}` });
    await recordAudit({ action: 'ptm_published', entity: 'ptm', entityId: id, changes: { students: ids.length, teachers: teachers.length } });
    void userId;
    return getPtm(id);
};

export const cancelPtm = async (id: string, reason: string) => {
    const p = await db.ptm.findFirst({ where: { id } });
    if (!p) throw notFound('PTM not found');
    if (['done', 'cancelled'].includes(p.status)) throw badRequest('This PTM is over');
    await db.ptm.update({ where: { id }, data: { status: 'cancelled', note: [p.note, `Cancelled: ${reason}`].filter(Boolean).join('\n') } });
    if (p.status === 'published') {
        const ids = (await studentsIn(p.academicYearId, p.sectionIds)).map((e) => e.student.id);
        raiseLater('ptm_cancelled', { parent: () => parentsOf(ids), student: () => studentsOf(ids) }, { title: p.title, date: showDay(p.date), reason }, { dedupe: `ptm-cancel:${id}` });
    }
    await recordAudit({ action: 'ptm_cancelled', entity: 'ptm', entityId: id, changes: { reason } });
    return getPtm(id);
};

/** Ends a PTM: bookings not met become "didn't come"; parents are told remarks are in. */
export const completePtm = async (id: string) => {
    const p = await db.ptm.findFirst({ where: { id } });
    if (!p) throw notFound('PTM not found');
    if (p.status !== 'published') throw badRequest('Only a published PTM can be closed');
    await db.ptmMeeting.updateMany({ where: { ptmId: id, status: { in: ['booked', 'waiting'] } }, data: { status: 'absent' } });
    await db.ptm.update({ where: { id }, data: { status: 'done' } });
    const { see } = await getSettings({ see: PTM.parentsSeeRemarks });
    if (see) {
        const met = await db.ptmMeeting.findMany({ where: { ptmId: id, status: 'attended', shared: true, OR: [{ remarks: { not: null } }, { remarkIds: { isEmpty: false } }] }, select: { studentId: true }, distinct: ['studentId'] });
        const ids = met.map((m) => m.studentId);
        if (ids.length) raiseLater('ptm_remarks', { parent: () => parentsOf(ids), student: () => studentsOf(ids) }, { title: p.title, date: showDay(p.date) }, { dedupe: `ptm-remarks:${id}` });
    }
    await recordAudit({ action: 'ptm_closed', entity: 'ptm', entityId: id, changes: {} });
    return getPtm(id);
};

export const deletePtm = async (id: string) => {
    const p = await db.ptm.findFirst({ where: { id } });
    if (!p) throw notFound('PTM not found');
    if (p.status !== 'draft') throw badRequest('Only a draft can be deleted; cancel a published PTM instead');
    await db.ptm.delete({ where: { id } });
    return { id, deleted: true };
};

/** Every meeting of a PTM (for the office): who met whom, and the remarks. */
export const ptmMeetings = async (id: string) => {
    const p = await db.ptm.findFirst({ where: { id } });
    if (!p) throw notFound('PTM not found');
    const meetings = await db.ptmMeeting.findMany({ where: { ptmId: id, status: { not: 'cancelled' } }, orderBy: [{ staffId: 'asc' }, { slot: 'asc' }] });
    const [students, staff, remarks] = await Promise.all([
        db.student.findMany({ where: { id: { in: meetings.map((m) => m.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.staff.findMany({ where: { id: { in: meetings.map((m) => m.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }),
        db.masterValue.findMany({ where: { master: 'ptm_remark' }, select: { id: true, name: true } }),
    ]);
    return meetings.map((m) => ({ id: m.id, teacher: staffName(staff.find((s) => s.id === m.staffId) ?? { firstName: '—' }), student: fullName(students.find((s) => s.id === m.studentId) ?? { firstName: '—' }), slot: m.slot, status: m.status, remarks: [...m.remarkIds.map((r) => remarks.find((x) => x.id === r)?.name).filter(Boolean), m.remarks].filter(Boolean).join('; '), actions: m.actions, followUpOn: m.followUpOn ? isoOf(m.followUpOn) : null }));
};

// ─── Parents ─────────────────────────────────────────────────────────────────

/** The children of a login (or the student themselves), with their section this session. */
const myChildren = async (userId: string) => {
    const year = await currentYear();
    if (!year) return { year: null, children: [] };
    const students = await db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true, firstName: true, middleName: true, lastName: true } });
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, sectionId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } });
    return { year, children: students.map((s) => ({ id: s.id, name: fullName(s), sectionId: enrol.find((e) => e.studentId === s.id)?.sectionId ?? null, section: enrol.find((e) => e.studentId === s.id) ? sectionLabel(enrol.find((e) => e.studentId === s.id)!.section) : '' })).filter((c) => c.sectionId) };
};

/** Booking is open: published, booking on, and before the cut-off. */
const bookingOpen = async (p: { status: string; booking: boolean; date: Date; startTime: string }) => {
    const { cutoff } = await getSettings({ cutoff: PTM.cutoffHours });
    const starts = Date.parse(`${isoOf(p.date)}T${p.startTime}:00+05:30`);
    return p.status === 'published' && p.booking && Date.now() < starts - cutoff * 3_600_000;
};

/** A parent's PTMs: upcoming ones to book (each child's teachers, their free slots, the bookings) and past ones with remarks. */
export const myPtms = async (userId: string) => {
    const { year, children } = await myChildren(userId);
    if (!year || !children.length) return { upcoming: [], past: [] };
    const s = await getSettings({ perSlot: PTM.perSlot, change: PTM.parentsChange, see: PTM.parentsSeeRemarks });
    const sectionIds = [...new Set(children.map((c) => c.sectionId!))];
    const ptms = await db.ptm.findMany({ where: { academicYearId: year.id, status: { in: ['published', 'done'] }, sectionIds: { hasSome: sectionIds } }, orderBy: { date: 'desc' }, take: 20 });
    const remarks = await db.masterValue.findMany({ where: { master: 'ptm_remark' }, select: { id: true, name: true, extra: true } });
    const topics = await db.masterValue.findMany({ where: { master: 'ptm_topic', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } });
    const out: { upcoming: unknown[]; past: unknown[] } = { upcoming: [], past: [] };
    for (const p of ptms) {
        await ensureTeachers(p);
        const { bySection } = await sittingBySection(p);
        const [rows, meetings] = await Promise.all([db.ptmTeacher.findMany({ where: { ptmId: p.id } }), db.ptmMeeting.findMany({ where: { ptmId: p.id, status: { not: 'cancelled' } }, select: { id: true, staffId: true, studentId: true, slot: true, status: true, topicIds: true, parentNote: true, remarkIds: true, remarks: true, actions: true, shared: true } })]);
        const staffIds = [...new Set(children.flatMap((c) => [...(bySection.get(c.sectionId!)?.keys() ?? [])]))];
        const staff = await db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, middleName: true, lastName: true } });
        const open = await bookingOpen(p);
        const slots = slotsOf(p);
        const childIds = children.map((c) => c.id);
        const mine = meetings.filter((m) => childIds.includes(m.studentId));
        const done = p.status === 'done';
        const view = {
            id: p.id,
            title: p.title,
            date: isoOf(p.date),
            startTime: p.startTime,
            endTime: p.endTime,
            mode: p.mode,
            booking: p.booking,
            bookingOpen: open,
            canChange: open && s.change,
            note: p.note,
            topics,
            children: children
                .filter((c) => p.sectionIds.includes(c.sectionId!))
                .map((c) => ({
                    id: c.id,
                    name: c.name,
                    section: c.section,
                    teachers: [...(bySection.get(c.sectionId!)?.entries() ?? [])].map(([staffId, info]) => {
                        const r = rows.find((x) => x.staffId === staffId);
                        const m = mine.find((x) => x.staffId === staffId && x.studentId === c.id);
                        const st = staff.find((x) => x.id === staffId);
                        const showRemarks = done && s.see && m?.shared && m.status === 'attended';
                        return {
                            staffId,
                            name: st ? staffName(st) : '',
                            role: info.classTeacher ? `Class teacher${info.subjects.length ? `, ${info.subjects.join(', ')}` : ''}` : info.subjects.join(', '),
                            room: r?.room ?? null,
                            link: r?.link ?? null,
                            away: r?.away ?? false,
                            meeting: m ? { id: m.id, slot: m.slot, status: m.status, topicIds: m.topicIds, note: m.parentNote, remarks: showRemarks ? { points: m.remarkIds.map((id) => remarks.find((x) => x.id === id)).filter(Boolean).map((x) => ({ name: x!.name, tone: (x!.extra as { tone?: string } | null)?.tone ?? 'info' })), text: m.remarks, actions: m.actions } : null } : null,
                            // Free slots: under the per-slot limit, and not when this family already has another meeting then.
                            free: open && !(r?.away ?? false) ? slots.filter((t) => meetings.filter((x) => x.staffId === staffId && x.slot === t).length < s.perSlot && !mine.some((x) => x.slot === t && !(x.staffId === staffId && x.studentId === c.id))) : [],
                        };
                    }),
                })),
        };
        if (done || isoOf(p.date) < todayIST()) out.past.push(view);
        else out.upcoming.push(view);
    }
    out.upcoming.reverse();
    return out;
};

export const bookSchema = z.strictObject({ ptmId: z.uuid(), staffId: z.uuid(), studentId: z.uuid(), slot: TIME, topicIds: z.array(z.uuid()).max(8).default([]), note: z.string().trim().max(300).nullable().optional() });

export const book = async (input: z.infer<typeof bookSchema>, userId: string) => {
    const { children } = await myChildren(userId);
    const child = children.find((c) => c.id === input.studentId);
    if (!child) throw forbidden();
    const p = await db.ptm.findFirst({ where: { id: input.ptmId } });
    if (!p || !p.sectionIds.includes(child.sectionId!)) throw notFound('PTM not found');
    if (!(await bookingOpen(p))) throw badRequest('Booking for this PTM is closed');
    const { bySection } = await sittingBySection(p);
    if (!bySection.get(child.sectionId!)?.has(input.staffId)) throw badRequest('This teacher doesn’t meet parents of this class at this PTM');
    const t = await db.ptmTeacher.findFirst({ where: { ptmId: p.id, staffId: input.staffId } });
    if (t?.away) throw badRequest('This teacher is away on the PTM day');
    if (!slotsOf(p).includes(input.slot)) throw badRequest('Not a slot of this PTM');
    const s = await getSettings({ perSlot: PTM.perSlot, change: PTM.parentsChange });
    const existing = await db.ptmMeeting.findFirst({ where: { ptmId: p.id, staffId: input.staffId, studentId: input.studentId } });
    if (existing && existing.status !== 'cancelled' && existing.slot && !s.change) throw badRequest('Already booked; the school doesn’t allow changes');
    const taken = await db.ptmMeeting.count({ where: { ptmId: p.id, staffId: input.staffId, slot: input.slot, status: { not: 'cancelled' }, ...(existing ? { id: { not: existing.id } } : {}) } });
    if (taken >= s.perSlot) throw badRequest('This time was just taken; choose another');
    const ids = children.map((c) => c.id);
    const clash = await db.ptmMeeting.findFirst({ where: { ptmId: p.id, studentId: { in: ids }, slot: input.slot, status: { not: 'cancelled' }, ...(existing ? { id: { not: existing.id } } : {}) } });
    if (clash) throw badRequest('You already have a meeting at this time; choose another');
    const data = { slot: input.slot, topicIds: input.topicIds, parentNote: input.note || null, status: 'booked', bookedBy: userId };
    const m = existing ? await db.ptmMeeting.update({ where: { id: existing.id }, data }) : await db.ptmMeeting.create({ data: { ...data, tenantId: getTenantId()!, ptmId: p.id, staffId: input.staffId, studentId: input.studentId } });
    await recordAudit({ action: existing ? 'ptm_booking_changed' : 'ptm_booked', entity: 'ptm', entityId: p.id, changes: { student: child.name, slot: input.slot } });
    return { id: m.id, slot: m.slot };
};

export const cancelBooking = async (meetingId: string, userId: string) => {
    const m = await db.ptmMeeting.findFirst({ where: { id: meetingId } });
    if (!m) throw notFound('Booking not found');
    const { children } = await myChildren(userId);
    if (!children.some((c) => c.id === m.studentId)) throw forbidden();
    const p = await db.ptm.findFirst({ where: { id: m.ptmId } });
    const { change } = await getSettings({ change: PTM.parentsChange });
    if (!p || !(await bookingOpen(p)) || !change) throw badRequest('Bookings can’t be changed now');
    if (m.status !== 'booked') throw badRequest('This meeting has started or is over');
    await db.ptmMeeting.update({ where: { id: meetingId }, data: { status: 'cancelled' } });
    return { cancelled: true };
};

// ─── Teachers ────────────────────────────────────────────────────────────────

/** Attendance % this session of some students (present weight / days not excused). */
export const attendancePercent = async (yearId: string, studentIds: string[]) => {
    const year = await db.academicYear.findFirst({ where: { id: yearId }, select: { startDate: true, endDate: true } });
    if (!year || !studentIds.length) return new Map<string, number | null>();
    const [marks, statuses] = await Promise.all([db.attendanceMark.findMany({ where: { studentId: { in: studentIds }, sheet: { date: { gte: year.startDate, lte: year.endDate }, slot: 'day' } }, select: { studentId: true, statusId: true } }), db.masterValue.findMany({ where: { master: 'attendance_status' }, select: { id: true, extra: true } })]);
    const w = new Map(statuses.map((s) => [s.id, (s.extra ?? {}) as { present?: number; excused?: boolean }]));
    const out = new Map<string, number | null>();
    for (const id of studentIds) {
        const mine = marks.filter((m) => m.studentId === id && !w.get(m.statusId)?.excused);
        out.set(id, mine.length ? Math.round((mine.reduce((a, m) => a + Number(w.get(m.statusId)?.present ?? 0), 0) / mine.length) * 1000) / 10 : null);
    }
    return out;
};

const myStaff = async (userId: string) => {
    const s = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!s) throw forbidden('Only a staff member meets parents');
    return s.id;
};

/** A teacher's PTMs, and for one of them the families they meet (booked or not), in slot order. */
export const myMeetings = async (userId: string, ptmId?: string) => {
    const staffId = await myStaff(userId);
    const year = await currentYear();
    if (!year) return { ptms: [], ptm: null };
    const all = await db.ptm.findMany({ where: { academicYearId: year.id, status: { in: ['published', 'done'] } }, orderBy: { date: 'desc' }, take: 30 });
    const mine: typeof all = [];
    for (const p of all) {
        const { bySection } = await sittingBySection(p);
        if ([...bySection.values()].some((m) => m.has(staffId))) mine.push(p);
    }
    const list = mine.map((p) => ({ id: p.id, title: p.title, date: isoOf(p.date), status: p.status }));
    const today = todayIST();
    const p = (ptmId ? mine.find((x) => x.id === ptmId) : null) ?? mine.filter((x) => isoOf(x.date) >= today).sort((a, b) => a.date.getTime() - b.date.getTime())[0] ?? mine[0];
    if (!p) return { ptms: list, ptm: null };
    const { sections, bySection } = await sittingBySection(p);
    const mySections = sections.filter((s) => bySection.get(s.id)?.has(staffId));
    const [enrol, meetings, row, topics] = await Promise.all([
        studentsIn(p.academicYearId, mySections.map((s) => s.id)),
        db.ptmMeeting.findMany({ where: { ptmId: p.id, staffId, status: { not: 'cancelled' } } }),
        db.ptmTeacher.findFirst({ where: { ptmId: p.id, staffId } }),
        db.masterValue.findMany({ where: { master: 'ptm_topic' }, select: { id: true, name: true } }),
    ]);
    const att = await attendancePercent(p.academicYearId, enrol.map((e) => e.student.id));
    const { see } = await getSettings({ see: PTM.parentsSeeRemarks });
    const families = enrol.map((e) => {
        const m = meetings.find((x) => x.studentId === e.student.id);
        const sec = mySections.find((s) => s.id === e.sectionId)!;
        return {
            studentId: e.student.id,
            name: fullName(e.student),
            admissionNo: e.student.admissionNo,
            roll: e.rollNumber,
            section: sectionLabel(sec),
            attendance: att.get(e.student.id) ?? null,
            meeting: m ? { id: m.id, slot: m.slot, status: m.status, topics: m.topicIds.map((t) => topics.find((x) => x.id === t)?.name).filter(Boolean), note: m.parentNote, remarkIds: m.remarkIds, remarks: m.remarks, actions: m.actions, followUpOn: m.followUpOn ? isoOf(m.followUpOn) : null, shared: m.shared, checkedInAt: m.checkedInAt } : null,
        };
    });
    families.sort((a, b) => (a.meeting?.slot ?? '99:99').localeCompare(b.meeting?.slot ?? '99:99') || a.section.localeCompare(b.section) || (a.roll ?? 999) - (b.roll ?? 999));
    return {
        ptms: list,
        ptm: { id: p.id, title: p.title, date: isoOf(p.date), startTime: p.startTime, endTime: p.endTime, status: p.status, mode: p.mode, room: row?.room ?? null, link: row?.link ?? null, away: row?.away ?? false, slots: slotsOf(p), sharedByDefault: see },
        families,
    };
};

export const meetingSchema = z.strictObject({
    status: z.enum(['attended', 'absent']),
    remarkIds: z.array(z.uuid()).max(20).default([]),
    remarks: z.string().trim().max(2000).nullable().optional(),
    actions: z.string().trim().max(1000).nullable().optional(),
    followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    shared: z.boolean().default(true),
});

/** The teacher marks a meeting (also a walk-in without a booking) and writes the remarks. */
export const saveMeeting = async (ptmId: string, studentId: string, input: z.infer<typeof meetingSchema>, userId: string, asStaffId?: string) => {
    const staffId = asStaffId ?? (await myStaff(userId));
    const p = await db.ptm.findFirst({ where: { id: ptmId } });
    if (!p || !['published', 'done'].includes(p.status)) throw badRequest('This PTM isn’t open');
    const { bySection } = await sittingBySection(p);
    const enrol = await db.enrolment.findFirst({ where: { academicYearId: p.academicYearId, studentId, sectionId: { in: p.sectionIds } }, select: { sectionId: true } });
    if (!enrol || !bySection.get(enrol.sectionId)?.has(staffId)) throw forbidden('You don’t meet this student’s parents at this PTM');
    const data = { status: input.status, remarkIds: input.remarkIds, remarks: input.remarks || null, actions: input.actions || null, followUpOn: input.followUpOn ? dayDate(input.followUpOn) : null, shared: input.shared, metAt: input.status === 'attended' ? new Date() : null };
    const m = await db.ptmMeeting.upsert({ where: { ptmId_staffId_studentId: { ptmId, staffId, studentId } }, create: { ...data, tenantId: getTenantId()!, ptmId, staffId, studentId }, update: data });
    return { id: m.id, status: m.status };
};

// ─── The desk ────────────────────────────────────────────────────────────────

/** Today's board: each teacher's room, who is waiting (checked in), who is next, and how many met. */
export const deskBoard = async (ptmId: string) => {
    const p = await db.ptm.findFirst({ where: { id: ptmId } });
    if (!p) throw notFound('PTM not found');
    await ensureTeachers(p);
    const [rows, meetings] = await Promise.all([db.ptmTeacher.findMany({ where: { ptmId } }), db.ptmMeeting.findMany({ where: { ptmId, status: { not: 'cancelled' } } })]);
    const [staff, students] = await Promise.all([db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.student.findMany({ where: { id: { in: meetings.map((m) => m.studentId) } }, select: { id: true, firstName: true, lastName: true } })]);
    const name = (id: string) => {
        const s = students.find((x) => x.id === id);
        return s ? [s.firstName, s.lastName].filter(Boolean).join(' ') : '';
    };
    const now = hhmm(minutesIST());
    return {
        ptm: { id: p.id, title: p.title, date: isoOf(p.date), startTime: p.startTime, endTime: p.endTime, status: p.status, now },
        teachers: rows
            .map((r) => {
                const mine = meetings.filter((m) => m.staffId === r.staffId);
                return {
                    staffId: r.staffId,
                    name: staffName(staff.find((x) => x.id === r.staffId) ?? { firstName: '—' }),
                    room: r.room,
                    away: r.away,
                    waiting: mine.filter((m) => m.status === 'waiting').sort((a, b) => (a.checkedInAt?.getTime() ?? 0) - (b.checkedInAt?.getTime() ?? 0)).map((m) => ({ id: m.id, student: name(m.studentId), slot: m.slot })),
                    next: mine.filter((m) => m.status === 'booked' && m.slot && m.slot >= now).sort((a, b) => a.slot!.localeCompare(b.slot!)).slice(0, 3).map((m) => ({ id: m.id, student: name(m.studentId), slot: m.slot })),
                    booked: mine.filter((m) => m.slot).length,
                    met: mine.filter((m) => m.status === 'attended').length,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
};

/** A family at the desk: the student's teachers at this PTM and their bookings. */
export const deskFamily = async (ptmId: string, studentId: string) => {
    const p = await db.ptm.findFirst({ where: { id: ptmId } });
    if (!p) throw notFound('PTM not found');
    const e = await db.enrolment.findFirst({ where: { academicYearId: p.academicYearId, studentId, sectionId: { in: p.sectionIds } }, select: { sectionId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } });
    if (!e) throw badRequest('This student’s section isn’t in this PTM');
    const { bySection } = await sittingBySection(p);
    const sitting = [...(bySection.get(e.sectionId)?.entries() ?? [])];
    const [staff, meetings, rows] = await Promise.all([db.staff.findMany({ where: { id: { in: sitting.map(([id]) => id) } }, select: { id: true, firstName: true, middleName: true, lastName: true } }), db.ptmMeeting.findMany({ where: { ptmId, studentId, status: { not: 'cancelled' } } }), db.ptmTeacher.findMany({ where: { ptmId } })]);
    return {
        student: { id: e.student.id, name: fullName(e.student), admissionNo: e.student.admissionNo, section: sectionLabel(e.section) },
        teachers: sitting.map(([staffId, info]) => {
            const m = meetings.find((x) => x.staffId === staffId);
            return { staffId, name: staffName(staff.find((x) => x.id === staffId) ?? { firstName: '—' }), role: info.classTeacher ? 'Class teacher' : info.subjects.join(', '), room: rows.find((r) => r.staffId === staffId)?.room ?? null, meeting: m ? { id: m.id, slot: m.slot, status: m.status } : null };
        }),
    };
};

export const checkInSchema = z.strictObject({ studentId: z.uuid(), staffIds: z.array(z.uuid()).min(1).max(30) });
/** Checks a family in for some teachers: their bookings become "waiting"; walk-ins are added (if allowed). */
export const checkIn = async (ptmId: string, input: z.infer<typeof checkInSchema>, userId: string) => {
    const fam = await deskFamily(ptmId, input.studentId);
    const { walk } = await getSettings({ walk: PTM.walkIns });
    let n = 0;
    for (const staffId of input.staffIds) {
        const t = fam.teachers.find((x) => x.staffId === staffId);
        if (!t) continue;
        if (t.meeting && ['attended', 'absent'].includes(t.meeting.status)) continue;
        if (t.meeting) await db.ptmMeeting.update({ where: { id: t.meeting.id }, data: { status: 'waiting', checkedInAt: new Date() } });
        else if (walk) await db.ptmMeeting.create({ data: { tenantId: getTenantId()!, ptmId, staffId, studentId: input.studentId, status: 'waiting', checkedInAt: new Date(), bookedBy: userId } });
        else continue;
        n++;
    }
    if (!n) throw badRequest(walk ? 'Nothing to check in' : 'Walk-ins are off (System Settings → PTM): only booked meetings can be checked in');
    return deskFamily(ptmId, input.studentId);
};

/** Students of a PTM's sections, for the desk's search. */
export const deskSearch = async (ptmId: string, q: string) => {
    const p = await db.ptm.findFirst({ where: { id: ptmId } });
    if (!p || q.trim().length < 2) return [];
    const t = q.trim();
    const rows = await db.enrolment.findMany({ where: { academicYearId: p.academicYearId, sectionId: { in: p.sectionIds }, student: { status: 'active', OR: [{ firstName: { startsWith: t, mode: 'insensitive' } }, { lastName: { startsWith: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] } }, take: 15, select: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } }, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } } } });
    return rows.map((r) => ({ id: r.student.id, name: fullName(r.student), admissionNo: r.student.admissionNo, section: sectionLabel(r.section) }));
};

/** PTMs the desk can run (today and coming ones, published). */
export const deskPtms = async () => (await db.ptm.findMany({ where: { status: 'published', date: { gte: dayDate(isoOf(new Date(Date.now() - 86_400_000))) } }, orderBy: { date: 'asc' }, take: 10 })).map((p) => ({ id: p.id, title: p.title, date: isoOf(p.date) }));
