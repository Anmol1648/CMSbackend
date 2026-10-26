import { z } from 'zod';
import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import { defineSetting } from '../../core/settings';

registerPermissions({ key: 'audit', label: 'Audit trail', order: 95 }, [
    { resource: 'audit', action: 'view', label: 'See the audit trail (who changed what, sign-ins, failed sign-ins)' },
]);

registerMenuItems([{ key: 'audit', app: false, label: 'Audit Trail', icon: 'history', href: '/audit', group: 'setup', order: 60, permission: 'audit.view' }]);

export const AUDIT = {
    retentionDays: defineSetting<number>({
        key: 'audit.retention_days',
        group: 'Audit',
        label: 'Keep audit records for (days)',
        help: 'Older records are deleted automatically once a day. 1095 days = 3 years.',
        type: 'number',
        default: 1095,
        schema: z.number().int().min(90).max(3650),
    }),
};
