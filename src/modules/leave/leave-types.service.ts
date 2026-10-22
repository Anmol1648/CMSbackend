import type { LeaveType } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { LEAVE_TYPE_SEED } from './leave.settings';

/** Leave types and their rules (Leave → Leave Setup). A school starts with the usual ones. */

const genderIdsNamed = async (name: string) => (await db.masterValue.findMany({ where: { master: 'gender', name: { equals: name, mode: 'insensitive' } }, select: { id: true } })).map((g) => g.id);

/** Every leave type (in order), filled with the usual ones the first time. */
export const leaveTypes = async (): Promise<LeaveType[]> => {
    const rows = await db.leaveType.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    if (rows.length) return rows;
    const [female, male] = await Promise.all([genderIdsNamed('Female'), genderIdsNamed('Male')]);
    await db.leaveType.createMany({
        data: LEAVE_TYPE_SEED.map((t, i) => {
            const { female: f, male: m, ...rest } = t as (typeof LEAVE_TYPE_SEED)[number] & { female?: boolean; male?: boolean };
            return { tenantId: getTenantId()!, sortOrder: i + 1, ...rest, genderIds: f ? female : m ? male : [] };
        }),
        skipDuplicates: true,
    });
    return db.leaveType.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
};

export const leaveTypeById = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw notFound('Leave type not found');
    const t = (await leaveTypes()).find((x) => x.id === id);
    if (!t) throw notFound('Leave type not found');
    return t;
};

/** Whether a staff member may take a type (staff type, employment type, gender). */
export const eligible = (t: LeaveType, s: { staffTypeId: string | null; employmentTypeId: string | null; genderId: string | null }) =>
    (!t.staffTypeIds.length || (!!s.staffTypeId && t.staffTypeIds.includes(s.staffTypeId))) &&
    (!t.employmentTypeIds.length || (!!s.employmentTypeId && t.employmentTypeIds.includes(s.employmentTypeId))) &&
    (!t.genderIds.length || (!!s.genderId && t.genderIds.includes(s.genderId)));

const days = z.number().min(0).max(366);
const ids = z.array(z.uuid()).max(50).default([]);

export const typeSchema = z
    .strictObject({
        code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9_-]+$/, 'letters and numbers only').transform((x) => x.toUpperCase()),
        name: z.string().trim().min(2).max(60),
        isActive: z.boolean().default(true),
        quota: days.nullable().default(null),
        credit: z.enum(['yearly', 'monthly', 'none']).default('yearly'),
        prorate: z.boolean().default(true),
        carryForward: z.enum(['none', 'all', 'upto']).default('none'),
        carryMax: days.nullable().default(null),
        halfDay: z.boolean().default(true),
        minDays: days.nullable().default(null),
        maxDays: days.nullable().default(null),
        noticeDays: z.number().int().min(0).max(180).default(0),
        backDays: z.number().int().min(0).max(180).default(7),
        certificateAfter: days.nullable().default(null),
        overdraw: z.enum(['block', 'lwp', 'allow']).default('block'),
        sandwich: z.boolean().default(false),
        paid: z.boolean().default(true),
        countsPresent: z.boolean().default(false),
        attendanceCode: z.string().trim().min(1).max(10).transform((x) => x.toUpperCase()).default('LV'),
        staffTypeIds: ids,
        employmentTypeIds: ids,
        genderIds: ids,
        approval: z.enum(['default', 'reports_to', 'two_level', 'office']).default('default'),
        isCompOff: z.boolean().default(false),
        compOffDays: z.number().int().min(1).max(730).nullable().default(null),
    })
    .refine((t) => t.carryForward !== 'upto' || t.carryMax != null, { message: 'give the most days that can be carried', path: ['carryMax'] })
    .refine((t) => t.minDays == null || t.maxDays == null || t.minDays <= t.maxDays, { message: 'is less than the minimum', path: ['maxDays'] })
    .refine((t) => t.credit === 'none' || t.quota != null, { message: 'give the days a year (or choose “not credited”)', path: ['quota'] });

/** The attendance status code must exist, so approved days show in the register. */
const checkStatus = async (code: string) => {
    const s = await db.masterValue.findFirst({ where: { master: 'attendance_status', code: { equals: code, mode: 'insensitive' } }, select: { id: true } });
    if (!s) throw badRequest(`There is no attendance status with the code ${code} (Masters → Attendance statuses)`, [{ field: 'attendanceCode', message: 'is not an attendance status' }]);
};

export const createType = async (input: z.infer<typeof typeSchema>) => {
    await leaveTypes();
    await checkStatus(input.attendanceCode);
    if (await db.leaveType.findFirst({ where: { code: input.code } })) throw conflict(`A leave type with the code ${input.code} already exists`);
    const last = await db.leaveType.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const row = await db.leaveType.create({ data: { tenantId: getTenantId()!, ...input, sortOrder: (last?.sortOrder ?? 0) + 1 } });
    await recordAudit({ action: 'leave_type_created', entity: 'leave_type', entityId: row.id, changes: { code: row.code, name: row.name } });
    return leaveTypes();
};

export const updateType = async (id: string, input: z.infer<typeof typeSchema>) => {
    const t = await leaveTypeById(id);
    await checkStatus(input.attendanceCode);
    if (input.code !== t.code && (await db.leaveType.findFirst({ where: { code: input.code } }))) throw conflict(`A leave type with the code ${input.code} already exists`);
    if (t.isCompOff !== input.isCompOff && (await db.staffLeave.count({ where: { leaveTypeId: id } }))) throw badRequest('Leave has already been taken of this type, so whether it is a comp-off can’t change. Add a new type instead.');
    await db.leaveType.update({ where: { id }, data: input });
    await recordAudit({ action: 'leave_type_updated', entity: 'leave_type', entityId: id, changes: { code: input.code, name: input.name } });
    return leaveTypes();
};

export const moveType = async (id: string, direction: 'up' | 'down') => {
    const list = await leaveTypes();
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) throw notFound('Leave type not found');
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j], list[i]];
    await db.$transaction(list.map((t, k) => db.leaveType.update({ where: { id: t.id }, data: { sortOrder: k + 1 } })));
    return leaveTypes();
};

/** Removes a type nobody has used; a used one can only be switched off. */
export const deleteType = async (id: string) => {
    const t = await leaveTypeById(id);
    if (await db.staffLeave.count({ where: { leaveTypeId: id } })) throw badRequest(`${t.name} has been used, so it can’t be deleted. Switch it off instead.`);
    await db.leaveType.delete({ where: { id } });
    await recordAudit({ action: 'leave_type_deleted', entity: 'leave_type', entityId: id, changes: { code: t.code } });
    return leaveTypes();
};
