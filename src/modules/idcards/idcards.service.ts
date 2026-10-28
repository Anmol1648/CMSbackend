import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { saveUpload } from '../../core/files';
import { getUserAccess } from '../rbac/access.service';
import { currentYear } from '../academic/years.service';
import { sectionLabel } from '../timetable/tt-setup.service';
import { fullName } from '../students/students.service';
import { setPhoto as setStudentPhoto } from '../students/student-files.service';
import { setPhoto as setStaffPhoto } from '../staff/staff-files.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { registerFeeSource } from '../fees/dues.service';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, usersOf } from '../alerts/recipients';
import { IDCARDS } from './idcards.settings';
import { documentFields, documentValues } from '../forms/forms.service';

/**
 * ID cards: designs (fields on the front and back), printing for a section or staff (each person
 * keeps one active card; a duplicate replaces it with a new number), checking a card by its QR,
 * photos (taken by the class teacher, or sent by parents and approved) and the digital card.
 */

const DAY = 86_400_000;
export type HolderType = 'student' | 'staff';

/** The fields a design can show, per kind. Back-only fields can also go on the front. */
export const FIELDS: Record<HolderType, { key: string; label: string }[]> = {
    student: [
        { key: 'photo', label: 'Photo' },
        { key: 'name', label: 'Name' },
        { key: 'class', label: 'Class' },
        { key: 'admissionNo', label: 'Admission no.' },
        { key: 'rollNo', label: 'Roll no.' },
        { key: 'dob', label: 'Date of birth' },
        { key: 'bloodGroup', label: 'Blood group' },
        { key: 'father', label: 'Father' },
        { key: 'mother', label: 'Mother' },
        { key: 'phone', label: 'Phone' },
        { key: 'address', label: 'Address' },
        { key: 'transport', label: 'Bus route / stop' },
        { key: 'house', label: 'House' },
        { key: 'emergency', label: 'Emergency contact' },
        { key: 'validUntil', label: 'Valid till' },
        { key: 'cardNo', label: 'Card no.' },
        { key: 'schoolAddress', label: 'School address and phone' },
    ],
    staff: [
        { key: 'photo', label: 'Photo' },
        { key: 'name', label: 'Name' },
        { key: 'designation', label: 'Designation' },
        { key: 'department', label: 'Department' },
        { key: 'employeeCode', label: 'Employee code' },
        { key: 'joiningDate', label: 'Joining date' },
        { key: 'dob', label: 'Date of birth' },
        { key: 'bloodGroup', label: 'Blood group' },
        { key: 'phone', label: 'Phone' },
        { key: 'address', label: 'Address' },
        { key: 'emergency', label: 'Emergency contact' },
        { key: 'validUntil', label: 'Valid till' },
        { key: 'cardNo', label: 'Card no.' },
        { key: 'schoolAddress', label: 'School address and phone' },
    ],
};

const fmt = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/** Where to load a person's photo (only through this module's checked route). */
const photoPath = (type: HolderType, id: string, fileId: string | null) => (fileId ? `idcards/photo/${type}/${id}?v=${fileId}` : null);

export const school = async () => {
    const p = await db.schoolProfile.findFirst({ include: { tenant: { select: { code: true } } } });
    if (!p) return { name: '', short: '', address: '', phone: '', logoUrl: null as string | null };
    return {
        name: p.legalName,
        short: p.shortName ?? p.legalName,
        address: [p.addressLine1, p.addressLine2, p.city, p.state, p.pincode].filter(Boolean).join(', '),
        phone: p.phone ?? '',
        logoUrl: p.logoFileId ? `public/school/logo?school=${p.tenant.code}&v=${p.logoFileId}` : null,
    };
};

/** When a card printed today stops being valid. */
const validTill = async (type: HolderType) => {
    const s = await getSettings({ v: IDCARDS.validity, m: IDCARDS.months });
    const year = await currentYear();
    if (type === 'student' && s.v === 'session' && year) return year.endDate;
    const d = dayDate(todayIST());
    d.setUTCMonth(d.getUTCMonth() + s.m);
    return d;
};

const newCardNo = async () => {
    const s = await getSettings({ p: IDCARDS.prefix, d: IDCARDS.digits });
    for (;;) {
        const no = `${s.p}${String(await takeNumbers('id_card', 1)).padStart(s.d, '0')}`;
        if (!(await db.idCard.findFirst({ where: { cardNo: no }, select: { id: true } }))) return no;
    }
};

export interface Holder {
    type: HolderType;
    id: string;
    name: string;
    photo: string | null;
    sub: string;
    values: Record<string, string>;
    card: { id: string; cardNo: string; validUntil: string; status: string } | null;
}

/** The people with every field worked out, and their current card (if any). */
export const holders = async (type: HolderType, ids: string[]): Promise<Holder[]> => {
    if (!ids.length) return [];
    const [sch, cards, masters] = await Promise.all([
        school(),
        db.idCard.findMany({ where: { holderType: type, status: 'active', ...(type === 'student' ? { studentId: { in: ids } } : { staffId: { in: ids } }) }, orderBy: { createdAt: 'desc' } }),
        db.masterValue.findMany({ where: { master: { in: ['blood_group', 'relation', 'house', 'designation', 'department'] } }, select: { id: true, name: true } }),
    ]);
    const mname = (id: string | null | undefined) => (id ? (masters.find((m) => m.id === id)?.name ?? '') : '');
    const cardOf = (id: string) => {
        const c = cards.find((x) => (type === 'student' ? x.studentId : x.staffId) === id);
        return c ? { id: c.id, cardNo: c.cardNo, validUntil: isoOf(c.validUntil), status: c.status } : null;
    };
    const schoolLine = [sch.address, sch.phone && `Ph ${sch.phone}`].filter(Boolean).join(' · ');
    if (type === 'staff') {
        const rows = await db.staff.findMany({ where: { id: { in: ids } } });
        const extra = await documentValues('staff', rows);
        const labels = Object.fromEntries((await documentFields('staff')).map((f) => [f.key, f.label]));
        return ids
            .map((id) => rows.find((r) => r.id === id))
            .filter((s): s is NonNullable<typeof s> => !!s)
            .map((s) => {
                const card = cardOf(s.id);
                return {
                    type,
                    id: s.id,
                    name: fullName(s),
                    photo: photoPath('staff', s.id, s.photoFileId),
                    sub: mname(s.designationId) || s.employeeCode,
                    card,
                    labels,
                    values: { name: fullName(s), designation: mname(s.designationId), department: mname(s.departmentId), employeeCode: s.employeeCode, joiningDate: fmt(s.joiningDate), dob: fmt(s.dateOfBirth), bloodGroup: mname(s.bloodGroupId), phone: s.mobile ?? '', address: [s.addressLine, s.pinCode].filter(Boolean).join(' - '), emergency: [s.emergencyName, s.emergencyPhone].filter(Boolean).join(' · '), validUntil: card ? fmt(dayDate(card.validUntil)) : '', cardNo: card?.cardNo ?? '', schoolAddress: schoolLine, ...Object.fromEntries(Object.entries(extra.get(s.id) ?? {}).map(([k, v]) => [`custom__${k}`, v])) },
                };
            });
    }
    const year = await currentYear();
    const today = dayDate(todayIST());
    const [rows, enrol, transport] = await Promise.all([
        db.student.findMany({ where: { id: { in: ids } }, include: { family: { include: { guardians: { orderBy: { isPrimary: 'desc' } } } } } }),
        year ? db.enrolment.findMany({ where: { academicYearId: year.id, studentId: { in: ids } }, include: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } }) : [],
        year ? db.studentTransport.findMany({ where: { academicYearId: year.id, studentId: { in: ids }, fromDate: { lte: today }, OR: [{ toDate: null }, { toDate: { gte: today } }] } }) : [],
    ]);
    const [routes, stops] = await Promise.all([db.transportRoute.findMany({ where: { id: { in: transport.map((t) => t.routeId) } }, select: { id: true, name: true } }), db.transportStop.findMany({ where: { id: { in: transport.map((t) => t.stopId) } }, select: { id: true, name: true } })]);
    const extra = await documentValues('student', rows);
    const labels = Object.fromEntries((await documentFields('student')).map((f) => [f.key, f.label]));
    return ids
        .map((id) => rows.find((r) => r.id === id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => {
            const e = enrol.find((x) => x.studentId === s.id);
            const g = s.family?.guardians ?? [];
            const rel = (n: string) => g.find((x) => mname(x.relationId) === n)?.name ?? '';
            const t = transport.find((x) => x.studentId === s.id);
            const card = cardOf(s.id);
            const cls = e ? sectionLabel(e.section) : '';
            return {
                type,
                id: s.id,
                name: fullName(s),
                photo: photoPath('student', s.id, s.photoFileId),
                sub: [cls, s.admissionNo].filter(Boolean).join(' · '),
                card,
                labels,
                values: {
                    name: fullName(s),
                    class: cls,
                    admissionNo: s.admissionNo,
                    rollNo: e?.rollNumber ? String(e.rollNumber) : '',
                    dob: fmt(s.dateOfBirth),
                    bloodGroup: mname(s.bloodGroupId),
                    father: rel('Father'),
                    mother: rel('Mother'),
                    phone: s.mobile ?? g.find((x) => x.mobile)?.mobile ?? '',
                    address: [s.addressLine, s.pinCode].filter(Boolean).join(' - '),
                    transport: t ? `${routes.find((r) => r.id === t.routeId)?.name ?? ''} · ${stops.find((x) => x.id === t.stopId)?.name ?? ''}` : '',
                    house: mname(e?.houseId),
                    emergency: [s.emergencyName, s.emergencyPhone].filter(Boolean).join(' · ') || [g[0]?.name, g[0]?.mobile].filter(Boolean).join(' · '),
                    validUntil: card ? fmt(dayDate(card.validUntil)) : '',
                    cardNo: card?.cardNo ?? '',
                    schoolAddress: schoolLine,
                    ...Object.fromEntries(Object.entries(extra.get(s.id) ?? {}).map(([k, v]) => [`custom__${k}`, v])),
                },
            };
        });
};

// ─── Designs ─────────────────────────────────────────────────────────────────

export const designSchema = z.strictObject({
    name: z.string().trim().min(2, 'is required').max(80),
    kind: z.enum(['student', 'staff']),
    orientation: z.enum(['portrait', 'landscape']),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'pick a colour'),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'pick a colour'),
    fields: z.array(z.string().max(30)).max(20),
    code: z.enum(['qr', 'barcode', 'none']),
    back: z.boolean(),
    backFields: z.array(z.string().max(30)).max(20),
    backText: z.string().trim().max(500).nullable().optional(),
    signatureFileId: z.uuid().nullable().optional(),
    signatureLabel: z.string().trim().max(60).nullable().optional(),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
});

const designOut = <T extends { signatureFileId: string | null; id: string }>(d: T) => ({ ...d, signatureUrl: d.signatureFileId ? `idcards/designs/${d.id}/signature?v=${d.signatureFileId}` : null });

export const listDesigns = async () => (await db.idCardDesign.findMany({ orderBy: [{ kind: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }], include: { _count: { select: { cards: true } } } })).map((d) => ({ ...designOut(d), cards: d._count.cards }));

export const saveDesign = async (id: string | null, input: z.infer<typeof designSchema>, userId: string) => {
    const allowed = new Set([...FIELDS[input.kind], ...(await documentFields(input.kind))].map((f) => f.key));
    const data = { ...input, fields: input.fields.filter((f) => allowed.has(f)), backFields: input.backFields.filter((f) => allowed.has(f)), backText: input.backText || null, signatureFileId: input.signatureFileId ?? null, signatureLabel: input.signatureLabel || null };
    if (input.isDefault) await db.idCardDesign.updateMany({ where: { kind: input.kind, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
    const d = id ? await db.idCardDesign.update({ where: { id }, data }) : await db.idCardDesign.create({ data: { ...data, tenantId: getTenantId()!, createdBy: userId } });
    return designOut(d);
};

export const deleteDesign = async (id: string) => {
    const used = await db.idCard.count({ where: { designId: id } });
    if (used) {
        await db.idCardDesign.update({ where: { id }, data: { isActive: false, isDefault: false } });
        return { deactivated: true };
    }
    await db.idCardDesign.delete({ where: { id } });
    return { deactivated: false };
};

export const copyDesign = async (id: string, userId: string) => {
    const d = await db.idCardDesign.findFirst({ where: { id } });
    if (!d) throw notFound('Design not found');
    const { id: _id, createdAt: _c, updatedAt: _u, tenantId: _t, isDemo: _d, ...rest } = d;
    return designOut(await db.idCardDesign.create({ data: { ...rest, name: `${d.name} (copy)`, isDefault: false, tenantId: getTenantId()!, createdBy: userId } }));
};

export const uploadImage = async (file: { buffer: Buffer; originalname: string }) => {
    const f = await saveUpload({ data: file.buffer, originalName: file.originalname, purpose: 'document', allowed: ['png', 'jpeg', 'webp'] });
    return { id: f.id };
};

// ─── Choosing and printing ───────────────────────────────────────────────────

export const options = async (userId: string) => {
    const [designs, year, a, s, sch] = await Promise.all([listDesigns(), currentYear(), getUserAccess(userId), getSettings({ fee: IDCARDS.duplicateFee }), school()]);
    const sections = year ? await db.section.findMany({ where: { academicYearId: year.id }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }], select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } } } }) : [];
    const [departments, designations] = await Promise.all([db.masterValue.findMany({ where: { master: 'department', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }), db.masterValue.findMany({ where: { master: 'designation', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } })]);
    const fields = { student: [...FIELDS.student, ...(await documentFields('student'))], staff: [...FIELDS.staff, ...(await documentFields('staff'))] };
    return { designs: designs.filter((d) => d.isActive), fields, sections: sections.map((x) => ({ id: x.id, name: sectionLabel(x) })), departments, designations, duplicateFee: s.fee, school: sch, can: { print: !!a.permissions['idcard.print'], design: !!a.permissions['idcard.design'] } };
};

export const pickSchema = z.strictObject({
    type: z.enum(['student', 'staff']),
    sectionId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    ids: z.array(z.uuid()).max(2000).optional(),
    withoutCard: z.boolean().default(false),
});
/** The people to print: a section, a department (or all staff), or chosen ones. */
export const pick = async (input: z.infer<typeof pickSchema>) => {
    let ids = input.ids ?? [];
    if (!ids.length && input.type === 'student') {
        const year = await currentYear();
        if (!year || !input.sectionId) throw badRequest('Choose a section');
        const e = await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: input.sectionId, student: { status: 'active' } }, orderBy: [{ rollNumber: 'asc' }], select: { studentId: true } });
        ids = e.map((x) => x.studentId);
    } else if (!ids.length) {
        ids = (await db.staff.findMany({ where: { status: 'working', ...(input.departmentId ? { departmentId: input.departmentId } : {}) }, orderBy: { firstName: 'asc' }, select: { id: true } })).map((x) => x.id);
    }
    const list = await holders(input.type, ids);
    return input.withoutCard ? list.filter((h) => !h.card) : list;
};

/** People search for printing one or a few. */
export const search = async (type: HolderType, q: string) => {
    const t = q.trim();
    if (t.length < 2) return [];
    if (type === 'staff') {
        const rows = await db.staff.findMany({ where: { status: 'working', OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { employeeCode: { contains: t, mode: 'insensitive' } }] }, take: 15, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } });
        return rows.map((r) => ({ id: r.id, name: fullName(r), sub: r.employeeCode }));
    }
    const rows = await db.student.findMany({ where: { status: 'active', OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] }, take: 15, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } });
    return rows.map((r) => ({ id: r.id, name: fullName(r), sub: r.admissionNo }));
};

export const printSchema = z.strictObject({ type: z.enum(['student', 'staff']), designId: z.uuid(), ids: z.array(z.uuid()).min(1).max(1000) });
/** Records a print: a new card for those without one, a reprint (same number) for the rest. */
export const print = async (input: z.infer<typeof printSchema>, userId: string) => {
    const design = await db.idCardDesign.findFirst({ where: { id: input.designId, kind: input.type } });
    if (!design) throw badRequest('Choose a design for this kind of card');
    const year = await currentYear();
    const until = await validTill(input.type);
    const existing = await db.idCard.findMany({ where: { holderType: input.type, status: 'active', ...(input.type === 'student' ? { studentId: { in: input.ids } } : { staffId: { in: input.ids } }) } });
    let added = 0;
    for (const id of input.ids) {
        const c = existing.find((x) => (input.type === 'student' ? x.studentId : x.staffId) === id);
        if (c) {
            await db.idCard.update({ where: { id: c.id }, data: { printCount: { increment: 1 }, lastPrintedAt: new Date(), designId: design.id } });
            continue;
        }
        await db.idCard.create({ data: { tenantId: getTenantId()!, cardNo: await newCardNo(), designId: design.id, holderType: input.type, studentId: input.type === 'student' ? id : null, staffId: input.type === 'staff' ? id : null, academicYearId: year?.id ?? null, validUntil: until, printCount: 1, lastPrintedAt: new Date(), issuedBy: userId } });
        added++;
    }
    await recordAudit({ action: 'id_cards_printed', entity: 'id_card', changes: { type: input.type, count: input.ids.length, new: added } });
    return { added, reprinted: input.ids.length - added, holders: await holders(input.type, input.ids) };
};

// ─── Cards given ─────────────────────────────────────────────────────────────

export const cardsQuery = z.object({
    type: z.enum(['student', 'staff', '']).default(''),
    status: z.enum(['active', 'replaced', 'cancelled', '']).default('active'),
    search: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).default(1),
});
export const listCards = async (q: z.infer<typeof cardsQuery>) => {
    const t = q.search ?? '';
    const [students, staff] = t.length >= 2 ? await Promise.all([db.student.findMany({ where: { OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { admissionNo: { contains: t, mode: 'insensitive' } }] }, select: { id: true }, take: 200 }), db.staff.findMany({ where: { OR: [{ firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }, { employeeCode: { contains: t, mode: 'insensitive' } }] }, select: { id: true }, take: 200 })]) : [[], []];
    const where = {
        ...(q.type ? { holderType: q.type } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(t.length >= 2 ? { OR: [{ cardNo: { contains: t, mode: 'insensitive' as const } }, { studentId: { in: students.map((s) => s.id) } }, { staffId: { in: staff.map((s) => s.id) } }] } : {}),
    };
    const [total, rows] = await Promise.all([db.idCard.count({ where }), db.idCard.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * 30, take: 30, include: { design: { select: { name: true } } } })]);
    const [st, sf, users] = await Promise.all([
        db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true } }),
        db.staff.findMany({ where: { id: { in: rows.map((r) => r.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, middleName: true, lastName: true, employeeCode: true } }),
        db.user.findMany({ where: { id: { in: rows.map((r) => r.issuedBy!).filter(Boolean) } }, select: { id: true, displayName: true } }),
    ]);
    return {
        total,
        page: q.page,
        pageSize: 30,
        rows: rows.map((r) => {
            const p = r.studentId ? st.find((x) => x.id === r.studentId) : sf.find((x) => x.id === r.staffId);
            return { id: r.id, cardNo: r.cardNo, type: r.holderType, holderId: r.studentId ?? r.staffId, designId: r.designId, name: p ? fullName(p) : '', code: p ? ('admissionNo' in p ? p.admissionNo : p.employeeCode) : '', design: r.design?.name ?? '', validUntil: isoOf(r.validUntil), status: r.status, reason: r.reason, fee: r.fee, printCount: r.printCount, issuedBy: users.find((u) => u.id === r.issuedBy)?.displayName ?? '', createdAt: r.createdAt };
        }),
    };
};

export const duplicateSchema = z.strictObject({ reason: z.enum(['lost', 'damaged', 'changed']), fee: z.number().int().min(0).max(10_000).nullable().optional() });
/** Replaces a card with a new one (new number); the old one stops being valid. */
export const duplicate = async (id: string, input: z.infer<typeof duplicateSchema>, userId: string) => {
    const c = await db.idCard.findFirst({ where: { id } });
    if (!c || c.status !== 'active') throw badRequest('Only an active card can be replaced');
    const s = await getSettings({ fee: IDCARDS.duplicateFee });
    const fee = c.holderType === 'student' && input.reason !== 'changed' ? (input.fee ?? s.fee) : 0;
    const year = await currentYear();
    await db.idCard.update({ where: { id }, data: { status: 'replaced', replacedAt: new Date() } });
    const n = await db.idCard.create({ data: { tenantId: getTenantId()!, cardNo: await newCardNo(), designId: c.designId, holderType: c.holderType, studentId: c.studentId, staffId: c.staffId, academicYearId: year?.id ?? c.academicYearId, validUntil: await validTill(c.holderType as HolderType), reason: input.reason, fee: fee || null, printCount: 0, issuedBy: userId } });
    await recordAudit({ action: 'id_card_duplicate', entity: 'id_card', entityId: n.id, changes: { old: c.cardNo, new: n.cardNo, reason: input.reason, fee } });
    return { id: n.id, cardNo: n.cardNo, designId: n.designId, type: n.holderType, holderId: n.studentId ?? n.staffId, fee };
};

export const cancelCard = async (id: string) => {
    const c = await db.idCard.findFirst({ where: { id } });
    if (!c || c.status !== 'active') throw badRequest('Only an active card can be cancelled');
    await db.idCard.update({ where: { id }, data: { status: 'cancelled', replacedAt: new Date() } });
    await recordAudit({ action: 'id_card_cancelled', entity: 'id_card', entityId: id, changes: { cardNo: c.cardNo } });
    return { id };
};

/** Records a single print (after a duplicate, or a reprint from Cards Given). */
export const markPrinted = async (id: string) => {
    const c = await db.idCard.findFirst({ where: { id } });
    if (!c) throw notFound('Card not found');
    await db.idCard.update({ where: { id }, data: { printCount: { increment: 1 }, lastPrintedAt: new Date() } });
    return holders(c.holderType as HolderType, [c.studentId ?? c.staffId!]);
};

/** Checks a scanned code: a card number (valid, replaced, expired…), or an admission no / employee code. */
export const verify = async (code: string) => {
    const t = code.trim();
    const card = await db.idCard.findFirst({ where: { cardNo: { equals: t, mode: 'insensitive' } } });
    let type: HolderType;
    let id: string;
    let status: 'valid' | 'replaced' | 'cancelled' | 'expired' | 'no_card' | 'left';
    if (card) {
        type = card.holderType as HolderType;
        id = (card.studentId ?? card.staffId)!;
        status = card.status === 'replaced' ? 'replaced' : card.status === 'cancelled' ? 'cancelled' : isoOf(card.validUntil) < todayIST() ? 'expired' : 'valid';
    } else {
        const st = await db.student.findFirst({ where: { admissionNo: { equals: t, mode: 'insensitive' } }, select: { id: true } });
        const sf = st ? null : await db.staff.findFirst({ where: { employeeCode: { equals: t, mode: 'insensitive' } }, select: { id: true } });
        if (!st && !sf) throw notFound(`No card or person with the code ${t}`);
        type = st ? 'student' : 'staff';
        id = (st ?? sf)!.id;
        status = 'no_card';
    }
    const left = type === 'student' ? (await db.student.findFirst({ where: { id }, select: { status: true } }))?.status !== 'active' : (await db.staff.findFirst({ where: { id }, select: { status: true } }))?.status !== 'working';
    if (left && status === 'valid') status = 'left';
    const [h] = await holders(type, [id]);
    return { status, cardNo: card?.cardNo ?? null, validUntil: card ? isoOf(card.validUntil) : null, holder: { type, name: h.name, sub: h.sub, photo: h.photo, bloodGroup: h.values.bloodGroup, transport: h.values.transport ?? '' }, current: h.card?.cardNo ?? null };
};

// ─── Photos ──────────────────────────────────────────────────────────────────

/** Sections whose photos a person may take. */
const photoScope = async (userId: string): Promise<'all' | string[]> => {
    const a = await getUserAccess(userId);
    if (a.permissions['idcard.print'] || a.permissions['idcard.photos'] === 'all') return 'all';
    if (!a.permissions['idcard.photos']) return [];
    const [staff, year] = await Promise.all([db.staff.findFirst({ where: { userId }, select: { id: true } }), currentYear()]);
    if (!staff || !year) return [];
    return (await db.section.findMany({ where: { academicYearId: year.id, classTeacherId: staff.id }, select: { id: true } })).map((s) => s.id);
};

export const photoSections = async (userId: string) => {
    const [scope, year] = await Promise.all([photoScope(userId), currentYear()]);
    if (!year) return [];
    const rows = await db.section.findMany({ where: { academicYearId: year.id, ...(scope === 'all' ? {} : { id: { in: scope } }) }, orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }], select: { id: true, name: true, schoolClass: { select: { name: true, shortName: true } }, enrolments: { where: { student: { status: 'active' } }, select: { student: { select: { photoFileId: true } } } } } });
    return rows.map((s) => ({ id: s.id, name: sectionLabel(s), students: s.enrolments.length, withPhoto: s.enrolments.filter((e) => e.student.photoFileId).length }));
};

export const sectionPhotos = async (sectionId: string, userId: string) => {
    const scope = await photoScope(userId);
    if (scope !== 'all' && !scope.includes(sectionId)) throw forbidden('Not your section');
    const year = await currentYear();
    const e = await db.enrolment.findMany({ where: { academicYearId: year?.id, sectionId, student: { status: 'active' } }, orderBy: [{ rollNumber: 'asc' }], select: { rollNumber: true, student: { select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } } } });
    return e.map((x) => ({ id: x.student.id, name: fullName(x.student), admissionNo: x.student.admissionNo, rollNo: x.rollNumber, photo: photoPath('student', x.student.id, x.student.photoFileId) }));
};

export const takeStudentPhoto = async (studentId: string, file: { buffer: Buffer; originalname: string }, userId: string) => {
    const scope = await photoScope(userId);
    if (scope !== 'all') {
        const year = await currentYear();
        const e = await db.enrolment.findFirst({ where: { academicYearId: year?.id, studentId, sectionId: { in: scope } } });
        if (!e) throw forbidden('Not a student of your section');
    }
    const r = await setStudentPhoto(studentId, { data: file.buffer, originalName: file.originalname });
    await db.idPhotoRequest.updateMany({ where: { studentId, status: 'pending' }, data: { status: 'rejected', note: 'A new photo was taken at school', answeredBy: userId, answeredAt: new Date() } });
    const s = await db.student.findFirst({ where: { id: studentId }, select: { photoFileId: true } });
    return { photo: photoPath('student', studentId, s?.photoFileId ?? null), photoUrl: r.photoUrl };
};

export const takeStaffPhoto = async (staffId: string, file: { buffer: Buffer; originalname: string }) => {
    await setStaffPhoto(staffId, { data: file.buffer, originalName: file.originalname });
    const s = await db.staff.findFirst({ where: { id: staffId }, select: { photoFileId: true } });
    return { photo: photoPath('staff', staffId, s?.photoFileId ?? null) };
};

/** May this person see this photo? Card staff, the class teacher, the person, or their parent. */
export const photoFile = async (type: HolderType, id: string, userId: string) => {
    const row = type === 'student' ? await db.student.findFirst({ where: { id }, select: { photoFileId: true, userId: true, family: { select: { guardians: { select: { userId: true } } } } } }) : await db.staff.findFirst({ where: { id }, select: { photoFileId: true, userId: true } });
    if (!row?.photoFileId) throw notFound('No photo');
    const a = await getUserAccess(userId);
    const family = (row as { family?: { guardians: { userId: string | null }[] } | null }).family;
    const own = row.userId === userId || !!family?.guardians.some((g) => g.userId === userId);
    if (!own && !['idcard.print', 'idcard.design', 'idcard.view', 'idcard.verify'].some((k) => a.permissions[k])) {
        if (type !== 'student' || !a.permissions['idcard.photos']) throw forbidden();
        const scope = await photoScope(userId);
        const year = await currentYear();
        if (scope !== 'all' && !(await db.enrolment.findFirst({ where: { academicYearId: year?.id, studentId: id, sectionId: { in: scope } } }))) throw forbidden();
    }
    return row.photoFileId;
};

export const photoRequests = async () => {
    const rows = await db.idPhotoRequest.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' } });
    const [st, users] = await Promise.all([db.student.findMany({ where: { id: { in: rows.map((r) => r.studentId) } }, select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, photoFileId: true } }), db.user.findMany({ where: { id: { in: rows.map((r) => r.uploadedBy!).filter(Boolean) } }, select: { id: true, displayName: true } })]);
    const year = await currentYear();
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year?.id, studentId: { in: rows.map((r) => r.studentId) } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } });
    return rows.map((r) => {
        const s = st.find((x) => x.id === r.studentId);
        const e = enrol.find((x) => x.studentId === r.studentId);
        return { id: r.id, studentId: r.studentId, student: s ? fullName(s) : '', admissionNo: s?.admissionNo ?? '', section: e ? sectionLabel(e.section) : '', current: s ? photoPath('student', s.id, s.photoFileId) : null, sent: `idcards/photo-requests/${r.id}/image`, by: users.find((u) => u.id === r.uploadedBy)?.displayName ?? '', at: r.createdAt };
    });
};

export const requestFile = async (id: string, userId: string) => {
    const r = await db.idPhotoRequest.findFirst({ where: { id } });
    if (!r) throw notFound('Not found');
    const a = await getUserAccess(userId);
    if (r.uploadedBy !== userId && !a.permissions['idcard.print']) throw forbidden();
    return r.fileId;
};

const applyRequestPhoto = async (studentId: string, fileId: string) => {
    await db.student.update({ where: { id: studentId }, data: { photoFileId: fileId } });
    await recordAudit({ action: 'update', entity: 'student', entityId: studentId, changes: { photo: 'photo sent from the app' } });
};

export const answerRequest = async (id: string, approve: boolean, note: string | null, userId: string) => {
    const r = await db.idPhotoRequest.findFirst({ where: { id } });
    if (!r || r.status !== 'pending') throw badRequest('Already answered');
    await db.idPhotoRequest.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', note, answeredBy: userId, answeredAt: new Date() } });
    if (approve) await applyRequestPhoto(r.studentId, r.fileId);
    const s = await db.student.findFirst({ where: { id: r.studentId }, select: { firstName: true, middleName: true, lastName: true } });
    if (r.uploadedBy) raiseLater('id_photo_answer', { sender: () => usersOf([r.uploadedBy!]) }, { student: s ? fullName(s) : '', result: approve ? 'accepted' : 'not accepted', note: note ?? '' }, { dedupe: `id-photo-answer:${id}` });
    return { id };
};

// ─── My ID card ──────────────────────────────────────────────────────────────

export const mine = async (userId: string) => {
    const [staff, students] = await Promise.all([db.staff.findFirst({ where: { userId }, select: { id: true } }), db.student.findMany({ where: { status: 'active', OR: [{ userId }, { family: { guardians: { some: { userId } } } }] }, select: { id: true } })]);
    return { staffId: staff?.id ?? null, studentIds: students.map((s) => s.id) };
};

export const myCards = async (userId: string) => {
    const s = await getSettings({ digital: IDCARDS.digital, parentPhotos: IDCARDS.parentPhotos, approval: IDCARDS.photoApproval });
    const m = await mine(userId);
    const [people, designs, requests, sch] = await Promise.all([
        Promise.all([m.staffId ? holders('staff', [m.staffId]) : Promise.resolve([] as Holder[]), holders('student', m.studentIds)]).then((x) => x.flat()),
        db.idCardDesign.findMany({ where: { isActive: true } }),
        db.idPhotoRequest.findMany({ where: { studentId: { in: m.studentIds } }, orderBy: { createdAt: 'desc' }, take: 20 }),
        school(),
    ]);
    const cards = await db.idCard.findMany({ where: { status: 'active', OR: [{ studentId: { in: m.studentIds } }, ...(m.staffId ? [{ staffId: m.staffId }] : [])] }, select: { studentId: true, staffId: true, designId: true } });
    const designFor = (h: Holder) => {
        const c = cards.find((x) => (h.type === 'student' ? x.studentId : x.staffId) === h.id);
        const d = designs.find((x) => x.id === c?.designId) ?? designs.find((x) => x.kind === h.type && x.isDefault) ?? designs.find((x) => x.kind === h.type);
        return d ? designOut(d) : null;
    };
    return {
        digital: s.digital,
        parentPhotos: s.parentPhotos,
        approval: s.approval,
        school: sch,
        people: people.map((h) => ({ ...h, design: designFor(h) })),
        requests: requests.map((r) => ({ id: r.id, studentId: r.studentId, status: r.status, note: r.note, at: r.createdAt })),
    };
};

export const sendPhoto = async (studentId: string, file: { buffer: Buffer; originalname: string }, userId: string) => {
    const s = await getSettings({ on: IDCARDS.parentPhotos, approval: IDCARDS.photoApproval });
    if (!s.on) throw forbidden('The school takes the photos');
    const m = await mine(userId);
    if (!m.studentIds.includes(studentId)) throw forbidden();
    const f = await saveUpload({ data: file.buffer, originalName: file.originalname, purpose: 'avatar', allowed: ['png', 'jpeg', 'webp'] });
    if (!s.approval) {
        await applyRequestPhoto(studentId, f.id);
        await db.idPhotoRequest.create({ data: { tenantId: getTenantId()!, studentId, fileId: f.id, uploadedBy: userId, status: 'approved', answeredAt: new Date() } });
        return { pending: false };
    }
    await db.idPhotoRequest.updateMany({ where: { studentId, status: 'pending' }, data: { status: 'rejected', note: 'A newer photo was sent', answeredAt: new Date() } });
    await db.idPhotoRequest.create({ data: { tenantId: getTenantId()!, studentId, fileId: f.id, uploadedBy: userId } });
    const st = await db.student.findFirst({ where: { id: studentId }, select: { firstName: true, middleName: true, lastName: true } });
    raiseLater('id_photo_sent', { office: () => holdersOf('idcard.print') }, { student: st ? fullName(st) : '' }, { dedupe: `id-photo:${studentId}:${todayIST()}` });
    return { pending: true };
};

// Duplicate fees in the student's fees: into the first instalment due on or after the day (else the last).
registerFeeSource(async (yearId, students, instalments) => {
    const out = new Map<string, { feeHeadId: string; instalmentId: string; amount: number }[]>();
    if (!students.length || !instalments.length) return out;
    const cards = await db.idCard.findMany({ where: { academicYearId: yearId, holderType: 'student', fee: { gt: 0 }, studentId: { in: students.map((s) => s.id) } }, select: { studentId: true, fee: true, createdAt: true } });
    if (!cards.length) return out;
    const { code } = await getSettings({ code: IDCARDS.feeHeadCode });
    const head = await db.masterValue.findFirst({ where: { master: 'fee_head', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
    if (!head) return out;
    const sorted = [...instalments].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    for (const c of cards) {
        const inst = sorted.find((i) => i.dueDate.getTime() >= c.createdAt.getTime() - DAY) ?? sorted[sorted.length - 1];
        const lines = out.get(c.studentId!) ?? [];
        const same = lines.find((l) => l.instalmentId === inst.id);
        if (same) same.amount += c.fee!;
        else lines.push({ feeHeadId: head.id, instalmentId: inst.id, amount: c.fee! });
        out.set(c.studentId!, lines);
    }
    return out;
});
