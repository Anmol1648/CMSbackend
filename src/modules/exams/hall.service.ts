import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { readFile } from '../../core/files';
import { fullName } from '../students/students.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { computeDues, dueStudents } from '../fees/dues.service';
import { raiseLater } from '../alerts/deliver';
import { staffOf } from '../alerts/recipients';
import { defineDailyJob } from '../alerts/jobs';
import { loadExam } from './setup.service';
import { takers } from './marks.service';
import { EXAMS2 } from './exams2.settings';

/**
 * The exam hall: admit cards (held when fees are overdue, if the school wants), the seating plan of
 * each paper session (rooms from Masters → Rooms & labs, classes mixed), and invigilation duties
 * (teachers whose subject is not being written, not on leave, fewest duties first).
 */

const DAY = 86_400_000;
const sessionKey = (date: string, time: string) => `${date}|${time}`;
const dataUrl = async (fileId: string | null | undefined) => {
    if (!fileId) return null;
    try {
        const { file, data } = await readFile(fileId);
        return `data:${file.mimeType};base64,${data.toString('base64')}`;
    } catch {
        return null;
    }
};
export const principalSignature = async () => dataUrl((await db.schoolProfile.findFirst({ select: { signatureFileId: true } }))?.signatureFileId);
export const photoData = dataUrl;

/** The papers of an exam: each date + start time with the class subjects written then. */
export const sessions = async (examId: string) => {
    const exam = await loadExam(examId);
    const subs = await db.examSubject.findMany({ where: { examId, date: { not: null } }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] });
    const [subjects, classes] = await Promise.all([db.subject.findMany({ where: { id: { in: subs.map((s) => s.subjectId) } }, select: { id: true, name: true } }), db.schoolClass.findMany({ where: { id: { in: subs.map((s) => s.classId) } }, select: { id: true, name: true, shortName: true, sortOrder: true } })]);
    const by = new Map<string, { date: string; startTime: string; endTime: string | null; papers: { examSubjectId: string; classId: string; className: string; subjectId: string; subject: string }[] }>();
    for (const s of subs) {
        const k = sessionKey(isoOf(s.date!), s.startTime ?? '');
        const row = by.get(k) ?? { date: isoOf(s.date!), startTime: s.startTime ?? '', endTime: s.endTime, papers: [] };
        const c = classes.find((x) => x.id === s.classId);
        row.papers.push({ examSubjectId: s.id, classId: s.classId, className: c?.shortName ?? c?.name ?? '', subjectId: s.subjectId, subject: subjects.find((x) => x.id === s.subjectId)?.name ?? '' });
        by.set(k, row);
    }
    const [seats, duties] = await Promise.all([db.examSeat.groupBy({ by: ['date', 'startTime'], where: { examId }, _count: { _all: true } }), db.examDuty.groupBy({ by: ['date', 'startTime'], where: { examId }, _count: { _all: true } })]);
    return {
        exam: { id: exam.id, name: exam.name, status: exam.status, kind: exam.kind },
        sessions: [...by.values()].map((x) => ({ ...x, seated: seats.find((s) => isoOf(s.date) === x.date && s.startTime === x.startTime)?._count._all ?? 0, duties: duties.find((s) => isoOf(s.date) === x.date && s.startTime === x.startTime)?._count._all ?? 0 })),
    };
};

/** Students writing a paper session (every class with a paper then), grouped by class. */
const writers = async (exam: { id: string; academicYearId: string; kind: string; candidates: unknown }, date: string, startTime: string) => {
    const subs = await db.examSubject.findMany({ where: { examId: exam.id, date: dayDate(date), startTime: startTime || null }, include: { exam: { select: { id: true } } } });
    const altSubs = startTime ? [] : await db.examSubject.findMany({ where: { examId: exam.id, date: dayDate(date), startTime: '' } });
    const all = [...subs, ...altSubs];
    const sections = await db.section.findMany({ where: { academicYearId: exam.academicYearId, classId: { in: all.map((s) => s.classId) }, isActive: true }, select: { id: true, classId: true, name: true, sortOrder: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] });
    const cand = exam.kind === 'supplementary' ? ((exam.candidates ?? {}) as Record<string, string[]>) : null;
    const byClass = new Map<string, { classLabel: string; students: { id: string; name: string; admissionNo: string; roll: number | null; section: string }[] }>();
    for (const sec of sections) {
        const seen = new Set<string>();
        for (const es of all.filter((x) => x.classId === sec.classId)) {
            for (const t of await takers(exam.academicYearId, sec.id, es.subjectId)) {
                if (seen.has(t.student.id)) continue;
                if (cand && !(cand[t.student.id] ?? []).includes(es.subjectId)) continue;
                seen.add(t.student.id);
                const g = byClass.get(sec.classId) ?? { classLabel: sec.schoolClass.shortName ?? sec.schoolClass.name, students: [] };
                g.students.push({ id: t.student.id, name: fullName(t.student), admissionNo: t.student.admissionNo, roll: t.rollNumber, section: sectionLabel(sec) });
                byClass.set(sec.classId, g);
            }
        }
    }
    return { byClass, subjectIds: [...new Set(all.map((s) => s.subjectId))] };
};

export const rooms = async () =>
    (await db.masterValue.findMany({ where: { master: 'room', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, extra: true } })).map((r) => ({ id: r.id, name: r.name, capacity: Number((r.extra as { capacity?: number })?.capacity ?? 0) || 40 }));

export const seatSchema = z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().max(10).default(''), roomIds: z.array(z.uuid()).min(1).max(60), duties: z.boolean().default(true) });

/** Seats every student writing that session in the chosen rooms (in order), classes mixed if the school wants. */
export const makeSeating = async (examId: string, input: z.infer<typeof seatSchema>, userId: string, opts: { isDemo?: boolean } = {}) => {
    const exam = await loadExam(examId);
    const [{ byClass, subjectIds }, all, s] = await Promise.all([writers(exam, input.date, input.startTime), rooms(), getSettings({ alt: EXAMS2.alternateClasses })]);
    const chosen = input.roomIds.map((id) => all.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
    const groups = [...byClass.values()].map((g) => g.students);
    const total = groups.reduce((a, g) => a + g.length, 0);
    if (!total) throw badRequest('No one writes a paper at that time');
    const capacity = chosen.reduce((a, r) => a + r.capacity, 0);
    if (capacity < total) throw badRequest(`${total} students but the rooms seat ${capacity}: add ${total - capacity} more seats (another room)`);
    // Classes mixed: one from each class in turn (neighbours write different papers).
    const order: { id: string }[] = [];
    if (s.alt && groups.length > 1) {
        const idx = groups.map(() => 0);
        while (order.length < total) for (let g = 0; g < groups.length; g++) if (idx[g] < groups[g].length) order.push(groups[g][idx[g]++]);
    } else for (const g of groups) order.push(...g);
    const tenantId = getTenantId()!;
    await db.examSeat.deleteMany({ where: { examId, date: dayDate(input.date), startTime: input.startTime } });
    const rows: { tenantId: string; examId: string; date: Date; startTime: string; roomId: string; studentId: string; seatNo: number; isDemo: boolean }[] = [];
    let k = 0;
    // Spread evenly over the rooms (not filling the first to the brim).
    const share = Math.ceil(total / chosen.length);
    for (const r of chosen) {
        const n = Math.min(r.capacity, share, total - k);
        for (let i = 0; i < n; i++) rows.push({ tenantId, examId, date: dayDate(input.date), startTime: input.startTime, roomId: r.id, studentId: order[k++].id, seatNo: i + 1, isDemo: !!opts.isDemo });
    }
    for (const r of chosen) {
        let seat = rows.filter((x) => x.roomId === r.id).length;
        while (k < total && seat < r.capacity) rows.push({ tenantId, examId, date: dayDate(input.date), startTime: input.startTime, roomId: r.id, studentId: order[k++].id, seatNo: ++seat, isDemo: !!opts.isDemo });
    }
    await db.examSeat.createMany({ data: rows });
    if (input.duties) await makeDuties(examId, input.date, input.startTime, subjectIds, opts);
    await recordAudit({ action: 'exam_seating', entity: 'exam', entityId: examId, changes: { date: input.date, startTime: input.startTime, students: total, rooms: chosen.length } });
    return seating(examId, input.date, input.startTime);
};

/** Invigilators for each room of a session: not teaching a subject written then, not on leave, fewest duties first. */
export const makeDuties = async (examId: string, date: string, startTime: string, subjectIds?: string[], opts: { isDemo?: boolean } = {}) => {
    const exam = await loadExam(examId);
    const subs = subjectIds ?? (await writers(exam, date, startTime)).subjectIds;
    const [seats, s, teachers, busy, onLeave, counts, endTime] = await Promise.all([
        db.examSeat.groupBy({ by: ['roomId'], where: { examId, date: dayDate(date), startTime }, _count: { _all: true } }),
        getSettings({ per: EXAMS2.perInvigilator }),
        db.teachingAssignment.findMany({ where: { academicYearId: exam.academicYearId, staff: { status: 'working' } }, select: { staffId: true, subjectId: true } }),
        db.examDuty.findMany({ where: { date: dayDate(date), startTime, examId: { not: examId } }, select: { staffId: true } }),
        db.staffLeave.findMany({ where: { status: 'approved', fromDate: { lte: dayDate(date) }, toDate: { gte: dayDate(date) } }, select: { staffId: true } }),
        db.examDuty.groupBy({ by: ['staffId'], where: { examId }, _count: { _all: true } }),
        db.examSubject.findFirst({ where: { examId, date: dayDate(date), startTime: startTime || null }, select: { endTime: true } }),
    ]);
    const writing = new Set(subs);
    const all = [...new Set(teachers.map((t) => t.staffId))];
    const blocked = new Set([...teachers.filter((t) => writing.has(t.subjectId)).map((t) => t.staffId), ...busy.map((b) => b.staffId), ...onLeave.map((l) => l.staffId)]);
    const load = new Map(counts.map((c) => [c.staffId, c._count._all]));
    await db.examDuty.deleteMany({ where: { examId, date: dayDate(date), startTime } });
    const free = all.filter((id) => !blocked.has(id)).sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b));
    const pool = free.length ? free : all.filter((id) => !onLeave.some((l) => l.staffId === id));
    const tenantId = getTenantId()!;
    const rows: { tenantId: string; examId: string; date: Date; startTime: string; endTime: string | null; roomId: string; staffId: string; isDemo: boolean }[] = [];
    let k = 0;
    for (const r of seats) {
        const need = Math.max(1, Math.ceil(r._count._all / s.per));
        for (let i = 0; i < need && pool.length; i++) rows.push({ tenantId, examId, date: dayDate(date), startTime, endTime: endTime?.endTime ?? null, roomId: r.roomId, staffId: pool[k++ % pool.length], isDemo: !!opts.isDemo });
    }
    if (rows.length) await db.examDuty.createMany({ data: rows });
    return rows.length;
};

/** The plan of a session: per room, its students in seat order and its invigilators. */
export const seating = async (examId: string, date: string, startTime: string) => {
    const [seats, duties, all] = await Promise.all([db.examSeat.findMany({ where: { examId, date: dayDate(date), startTime }, orderBy: [{ seatNo: 'asc' }] }), db.examDuty.findMany({ where: { examId, date: dayDate(date), startTime } }), rooms()]);
    const exam = await loadExam(examId);
    const [students, enrol, staff] = await Promise.all([
        db.student.findMany({ where: { id: { in: seats.map((s) => s.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.enrolment.findMany({ where: { academicYearId: exam.academicYearId, studentId: { in: seats.map((s) => s.studentId) } }, select: { studentId: true, rollNumber: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }),
        db.staff.findMany({ where: { id: { in: duties.map((d) => d.staffId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
    ]);
    const roomIds = [...new Set([...seats.map((s) => s.roomId), ...duties.map((d) => d.roomId)])];
    return {
        exam: { id: exam.id, name: exam.name },
        date,
        startTime,
        rooms: roomIds.map((rid) => ({
            roomId: rid,
            room: all.find((r) => r.id === rid)?.name ?? '',
            invigilators: duties.filter((d) => d.roomId === rid).map((d) => ({ dutyId: d.id, staffId: d.staffId, name: fullName(staff.find((x) => x.id === d.staffId) ?? { firstName: '' }) })),
            seats: seats
                .filter((s) => s.roomId === rid)
                .map((s) => {
                    const st = students.find((x) => x.id === s.studentId);
                    const e = enrol.find((x) => x.studentId === s.studentId);
                    return { seatNo: s.seatNo, studentId: s.studentId, name: st ? fullName(st) : '', admissionNo: st?.admissionNo ?? '', roll: e?.rollNumber ?? null, section: e ? sectionLabel(e.section) : '' };
                }),
        })),
    };
};

export const clearSeating = async (examId: string, date: string, startTime: string) => {
    await db.examSeat.deleteMany({ where: { examId, date: dayDate(date), startTime } });
    await db.examDuty.deleteMany({ where: { examId, date: dayDate(date), startTime } });
    return { cleared: true };
};

export const dutySchema = z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().max(10).default(''), roomId: z.uuid(), staffIds: z.array(z.uuid()).max(6) });
/** Sets the invigilators of a room by hand. */
export const setDuty = async (examId: string, input: z.infer<typeof dutySchema>) => {
    const end = await db.examSubject.findFirst({ where: { examId, date: dayDate(input.date), startTime: input.startTime || null }, select: { endTime: true } });
    await db.examDuty.deleteMany({ where: { examId, date: dayDate(input.date), startTime: input.startTime, roomId: input.roomId } });
    if (input.staffIds.length) await db.examDuty.createMany({ data: input.staffIds.map((staffId) => ({ tenantId: getTenantId()!, examId, date: dayDate(input.date), startTime: input.startTime, endTime: end?.endTime ?? null, roomId: input.roomId, staffId })) });
    return seating(examId, input.date, input.startTime);
};

/** A teacher's invigilation duties from today. */
export const myDuties = async (userId: string) => {
    const staff = await db.staff.findFirst({ where: { userId }, select: { id: true } });
    if (!staff) return [];
    const rows = await db.examDuty.findMany({ where: { staffId: staff.id, date: { gte: dayDate(todayIST()) } }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] });
    const [exams, all, seats] = await Promise.all([db.exam.findMany({ where: { id: { in: rows.map((r) => r.examId) } }, select: { id: true, name: true } }), rooms(), db.examSeat.groupBy({ by: ['examId', 'date', 'startTime', 'roomId'], where: { examId: { in: rows.map((r) => r.examId) } }, _count: { _all: true } })]);
    return rows.map((r) => ({ id: r.id, exam: exams.find((e) => e.id === r.examId)?.name ?? '', examId: r.examId, date: isoOf(r.date), startTime: r.startTime, endTime: r.endTime, room: all.find((x) => x.id === r.roomId)?.name ?? '', students: seats.find((s) => s.examId === r.examId && isoOf(s.date) === isoOf(r.date) && s.startTime === r.startTime && s.roomId === r.roomId)?._count._all ?? 0 }));
};

// ─── Admit cards ─────────────────────────────────────────────────────────────

/** Who in a section may get the admit card: held ones have overdue fees above the limit (unless given anyway). */
export const admitList = async (examId: string, sectionId: string) => {
    const exam = await loadExam(examId);
    const section = await db.section.findFirst({ where: { id: sectionId, academicYearId: exam.academicYearId }, select: { id: true, classId: true, name: true, schoolClass: { select: { name: true, shortName: true } } } });
    if (!section || !exam.classIds.includes(section.classId)) throw notFound('That section does not write this exam');
    const s = await getSettings({ hold: EXAMS2.admitFeeHold, limit: EXAMS2.admitFeeLimit });
    const enrol = await db.enrolment.findMany({ where: { academicYearId: exam.academicYearId, sectionId, student: { status: 'active' } }, orderBy: [{ rollNumber: 'asc' }], select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } } } });
    const cand = exam.kind === 'supplementary' ? ((exam.candidates ?? {}) as Record<string, string[]>) : null;
    const list = cand ? enrol.filter((e) => (cand[e.student.id] ?? []).length) : enrol;
    let dues = new Map<string, number>();
    if (s.hold && list.length) {
        const ds = await dueStudents(exam.academicYearId, { id: { in: list.map((e) => e.student.id) } });
        const d = await computeDues(exam.academicYearId, ds);
        dues = new Map([...d.entries()].map(([id, x]) => [id, x.totals.overdue]));
    }
    return {
        section: sectionLabel(section),
        hold: s.hold,
        limit: s.limit,
        students: list.map((e) => {
            const due = dues.get(e.student.id) ?? 0;
            const held = s.hold && due > s.limit && !exam.admitReleased.includes(e.student.id);
            return { id: e.student.id, name: fullName(e.student), admissionNo: e.student.admissionNo, roll: e.rollNumber, photo: !!e.student.photoFileId, due, held, released: exam.admitReleased.includes(e.student.id) };
        }),
    };
};

export const releaseAdmit = async (examId: string, studentId: string, release: boolean, userId: string) => {
    const exam = await loadExam(examId);
    const set = new Set(exam.admitReleased);
    if (release) set.add(studentId);
    else set.delete(studentId);
    await db.exam.update({ where: { id: examId }, data: { admitReleased: [...set] } });
    await recordAudit({ action: release ? 'admit_card_given' : 'admit_card_held', entity: 'exam', entityId: examId, changes: { student: studentId, by: userId } });
    return { released: release };
};

/** The admit cards of a section (or one student), shaped for the document. */
export const admitCards = async (examId: string, sectionId: string, onlyStudentId?: string) => {
    const exam = await loadExam(examId);
    const list = await admitList(examId, sectionId);
    const keep = list.students.filter((s) => !s.held && (!onlyStudentId || s.id === onlyStudentId));
    const section = await db.section.findFirst({ where: { id: sectionId }, select: { classId: true } });
    const [subs, students, enrol, seats, all, s, sign, year] = await Promise.all([
        db.examSubject.findMany({ where: { examId, classId: section!.classId }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { sortOrder: 'asc' }] }),
        db.student.findMany({ where: { id: { in: keep.map((k) => k.id) } }, select: { id: true, photoFileId: true, dateOfBirth: true, family: { select: { guardians: { select: { name: true, relation: { select: { name: true } } } } } } } }),
        db.enrolment.findMany({ where: { academicYearId: exam.academicYearId, studentId: { in: keep.map((k) => k.id) } }, select: { studentId: true, optionalSubjectIds: true } }),
        db.examSeat.findMany({ where: { examId, studentId: { in: keep.map((k) => k.id) } } }),
        rooms(),
        getSettings({ instr: EXAMS2.admitInstructions }),
        principalSignature(),
        db.academicYear.findUnique({ where: { id: exam.academicYearId }, select: { name: true } }),
    ]);
    const subjects = await db.subject.findMany({ where: { id: { in: subs.map((x) => x.subjectId) } }, select: { id: true, name: true } });
    const cand = exam.kind === 'supplementary' ? ((exam.candidates ?? {}) as Record<string, string[]>) : null;
    const cards = [];
    for (const k of keep) {
        const st = students.find((x) => x.id === k.id);
        const g = st?.family?.guardians ?? [];
        const optional = enrol.find((e) => e.studentId === k.id)?.optionalSubjectIds ?? [];
        const rows = subs.filter((x) => !cand || (cand[k.id] ?? []).includes(x.subjectId));
        const fmt = (d: Date | null) => (d ? d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'To be announced');
        cards.push({
            exam: exam.name,
            year: year?.name ?? '',
            student: { name: k.name, admissionNo: k.admissionNo, roll: k.roll ?? '', section: list.section, father: g.find((x) => x.relation && /father/i.test(x.relation.name))?.name ?? '', dateOfBirth: st?.dateOfBirth ? isoOf(st.dateOfBirth) : null, photo: await dataUrl(st?.photoFileId) },
            papers: rows.map((x) => {
                const seat = seats.find((y) => y.studentId === k.id && x.date && isoOf(y.date) === isoOf(x.date) && y.startTime === (x.startTime ?? ''));
                return { subject: subjects.find((y) => y.id === x.subjectId)?.name ?? '', date: fmt(x.date), time: [x.startTime, x.endTime].filter(Boolean).join(' – '), seat: seat ? `${all.find((r) => r.id === seat.roomId)?.name ?? ''} · Seat ${seat.seatNo}` : '', optional: optional.includes(x.subjectId) };
            }),
            instructions: s.instr.split('\n').map((x) => x.trim()).filter(Boolean),
            signature: sign,
        });
    }
    return { cards, held: list.students.filter((x) => x.held).length };
};

// ─── Reminders ───────────────────────────────────────────────────────────────

defineDailyJob({
    key: 'exam_duty_reminder',
    run: async () => {
        const { on } = await getSettings({ on: EXAMS2.dutyReminder });
        if (!on) return 'off';
        const tomorrow = isoOf(new Date(dayDate(todayIST()).getTime() + DAY));
        const rows = await db.examDuty.findMany({ where: { date: dayDate(tomorrow) } });
        if (!rows.length) return 'none';
        const [exams, all] = await Promise.all([db.exam.findMany({ where: { id: { in: rows.map((r) => r.examId) } }, select: { id: true, name: true } }), rooms()]);
        for (const r of rows) raiseLater('exam_duty', { teacher: () => staffOf([r.staffId]) }, { exam: exams.find((e) => e.id === r.examId)?.name ?? '', date: tomorrow, time: [r.startTime, r.endTime].filter(Boolean).join(' – '), room: all.find((x) => x.id === r.roomId)?.name ?? '' }, { dedupe: `exam-duty:${r.id}` });
        return `${rows.length} reminders`;
    },
});
