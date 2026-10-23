import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import './promotion.settings';

registerPermissions({ key: 'promotion', label: 'Promotion & TC', order: 33 }, [
    { resource: 'promotion', action: 'manage', label: 'Promote students to the next session (and undo it)' },
    { resource: 'tc', action: 'manage', label: 'Ask for, issue and cancel transfer certificates' },
    { resource: 'tc', action: 'clear', label: 'Tick TC clearances (library, laboratory…)' },
    { resource: 'certificate', action: 'issue', label: 'Print bonafide and character certificates' },
]);

registerMenuItems([
    { key: 'promotion', label: 'Promotion', icon: 'upgrade', href: '/students/promotion', group: 'students', order: 40, permission: 'promotion.manage' },
    { key: 'transfer-certificates', label: 'Transfer Certificates', icon: 'assignment_return', href: '/students/tc', group: 'students', order: 45, anyPermission: ['tc.manage', 'tc.clear'] },
]);
