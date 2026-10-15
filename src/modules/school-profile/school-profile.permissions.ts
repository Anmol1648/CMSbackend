import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'school', label: 'School profile', order: 10 }, [
    { resource: 'school_profile', action: 'update', label: "Edit the school's name, address, board and formats" },
]);

// Every signed-in user may look at the profile; editing needs school_profile.update.
registerMenuItems([{ key: 'school-profile', label: 'School Profile', icon: 'account_balance', href: '/school-profile', group: 'setup', order: 10 }]);
