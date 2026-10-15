import { db } from '../db';
import { getContext } from '../context';
import { logger } from '../logger';

/**
 * Writes one audit-log entry for the current school. Used for security events now (sign-in,
 * sign-out, password changes); F6 adds automatic field-level change records for data edits.
 * An audit failure is logged but never fails the user's request.
 */

// Field names holding secrets. Dotted keys are settings (e.g. passwords.min_length) and are kept.
const SECRET_FIELDS = /^(password|passwordHash|password_hash|mfaSecretEnc|mfa_secret_enc|secret|token|refreshToken|codeHash|code_hash|code)$/i;

export interface AuditEvent {
    action: string;
    entity: string;
    entityId?: string | null;
    changes?: Record<string, unknown>;
    /** Overrides the signed-in user (e.g. the user who just signed in). */
    userId?: string | null;
    /** Overrides the context school (e.g. events before a school is in context). */
    tenantId?: string;
}

const mask = (changes?: Record<string, unknown>) =>
    changes && Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, SECRET_FIELDS.test(k) ? '***' : v]));

export const recordAudit = async (event: AuditEvent) => {
    const ctx = getContext();
    const tenantId = event.tenantId ?? ctx?.tenantId;
    if (!tenantId) return;
    try {
        await db.auditLog.create({
            data: {
                tenantId,
                userId: event.userId === undefined ? ctx?.user?.id ?? null : event.userId,
                action: event.action,
                entity: event.entity,
                entityId: event.entityId ?? null,
                changes: (mask(event.changes) as object) ?? undefined,
                ip: ctx?.ip ?? null,
                userAgent: ctx?.userAgent ?? null,
                requestId: ctx?.requestId ?? null,
            },
        });
    } catch (error) {
        logger.error('Audit log write failed', { action: event.action, error });
    }
};
