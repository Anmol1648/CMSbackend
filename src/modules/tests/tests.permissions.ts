import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import './tests.settings';

registerPermissions({ key: 'tests', label: 'Online Tests', order: 39.5 }, [
    { resource: 'test', action: 'create', label: 'Make online tests from the question bank', description: 'Assigned = the sections and subjects they teach (every subject of their own class).', scopes: ['all', 'assigned'] },
    { resource: 'test', action: 'mark', label: 'Mark written answers and publish results of tests they can see' },
    { resource: 'test', action: 'view', label: 'See online tests, results and the analysis', description: 'Assigned = the sections they teach or are class teacher of.', scopes: ['all', 'assigned'] },
    { resource: 'test', action: 'take', label: 'Take online tests (students); see their (children’s) results' },
]);

registerMenuItems([
    { key: 'online-tests', label: 'Online Tests', icon: 'assignment', href: '/tests', group: 'learning', order: 30, anyPermission: ['test.create', 'test.view'] },
    { key: 'my-tests', label: 'My Tests', icon: 'assignment', href: '/my-tests', group: 'main', order: 27, permission: 'test.take' },
]);
