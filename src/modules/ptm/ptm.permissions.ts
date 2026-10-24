import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './ptm.settings';

registerPermissions({ key: 'ptm', label: 'Parent–Teacher Meetings', order: 46 }, [
    { resource: 'ptm', action: 'manage', label: 'Plan PTMs (sections, times, slots, who sits), publish them and see every meeting and remark' },
    { resource: 'ptm', action: 'desk', label: 'Run the PTM desk: check parents in (also walk-ins) and see who is waiting for whom' },
    { resource: 'ptm', action: 'meet', label: 'Meet parents at PTMs: their slots, mark met / didn’t come, write remarks' },
    { resource: 'ptm', action: 'mine', label: 'Book PTM slots for their children and see the teachers’ remarks' },
]);

registerMenuGroup({ key: 'ptm', label: 'PTM', order: 18 });
registerMenuItems([
    { key: 'ptm-list', label: 'PTMs', icon: 'groups', href: '/ptm', group: 'ptm', order: 10, permission: 'ptm.manage' },
    { key: 'ptm-desk', label: 'PTM Desk', icon: 'how_to_reg', href: '/ptm/desk', group: 'ptm', order: 20, anyPermission: ['ptm.desk', 'ptm.manage'] },
    { key: 'ptm-meet', label: 'My PTM', icon: 'groups', href: '/ptm/meet', group: 'main', order: 31, permission: 'ptm.meet' },
    { key: 'ptm-mine', label: 'PTM', icon: 'groups', href: '/my-ptm', group: 'main', order: 31, permission: 'ptm.mine' },
]);
