import { db } from '../../core/db';
import { runAsSystem } from '../../core/context';
import { logger } from '../../core/logger';

/** Writes one line of the platform log (never fails the action that wrote it). */
export const platformLog = async (userId: string | null, action: string, o: { tenantId?: string | null; schoolName?: string | null; details?: object; ip?: string | null }) => {
    try {
        await runAsSystem(() => db.platformLog.create({ data: { userId, action, tenantId: o.tenantId ?? null, schoolName: o.schoolName ?? null, details: o.details ?? {}, ip: o.ip ?? null } }));
    } catch (err) {
        logger.warn('Platform log write failed', { action, error: (err as Error).message });
    }
};
