import { z } from 'zod';
import { defineSetting } from '../../core/settings';

/** System Settings → Dashboard. Who sets up the role dashboards is in Roles & Permissions (dashboard.setup). */

const G = 'Dashboard';

export const DASHBOARD = {
    personal: defineSetting<boolean>({ key: 'dashboard.personal', group: G, label: 'People can arrange their own dashboard', help: 'Add, remove, move and resize widgets for themselves. Off: everyone sees their role’s dashboard.', type: 'boolean', default: true, schema: z.boolean() }),
    actions: defineSetting<boolean>({ key: 'dashboard.action_centre', group: G, label: 'Show “Waiting for you” at the top of the dashboard', type: 'boolean', default: true, schema: z.boolean() }),
};
