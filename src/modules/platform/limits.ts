import { db } from '../../core/db';
import { getTenantId, runAsSystem } from '../../core/context';
import { AppError } from '../../core/errors';
import { ErrorCode } from '../../core/auth.types';

/**
 * What a school's plan allows (Platform console → the school → Limits): students, AI requests a
 * month and file storage. 0 or missing = no limit. Checked where things are added.
 */

export interface SchoolLimits {
    maxStudents?: number;
    aiMonthly?: number;
    storageMb?: number;
}

const limitsOf = async (tenantId: string): Promise<SchoolLimits> => ((await runAsSystem(() => db.tenant.findUnique({ where: { id: tenantId }, select: { limits: true } })))?.limits ?? {}) as SchoolLimits;

class LimitError extends AppError {
    constructor(message: string) {
        super(message, 403, ErrorCode.FORBIDDEN);
    }
}

/** Before admitting students: the plan's student limit. */
export const checkStudentLimit = async (adding = 1) => {
    const tenantId = getTenantId();
    if (!tenantId) return;
    const { maxStudents } = await limitsOf(tenantId);
    if (!maxStudents) return;
    const now = await db.student.count({ where: { status: 'active' } });
    if (now + adding > maxStudents) throw new LimitError(`Your plan allows ${maxStudents} students (you have ${now}). Ask Klytos to raise the limit.`);
};

/** Before saving a file: the plan's storage limit. */
export const checkStorageLimit = async (bytes: number) => {
    const tenantId = getTenantId();
    if (!tenantId) return;
    const { storageMb } = await limitsOf(tenantId);
    if (!storageMb) return;
    const used = (await db.file.aggregate({ _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
    if (used + bytes > storageMb * 1024 * 1024) throw new LimitError(`Your plan allows ${storageMb} MB of files (${Math.round(used / 1024 / 1024)} MB used). Ask Klytos to raise the limit.`);
};

/** The plan's cap on AI requests a month (0 = none); the school's own setting may be lower. */
export const aiMonthlyCap = async () => {
    const tenantId = getTenantId();
    return tenantId ? ((await limitsOf(tenantId)).aiMonthly ?? 0) : 0;
};
