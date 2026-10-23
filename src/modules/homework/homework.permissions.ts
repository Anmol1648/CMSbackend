import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './homework.settings';

registerPermissions({ key: 'homework', label: 'Homework', order: 35 }, [
    { resource: 'homework', action: 'give', label: 'Give homework', description: 'Assigned = the subjects they teach (Subject Teachers), and every subject of the section they are class teacher of.', scopes: ['all', 'assigned'] },
    { resource: 'homework', action: 'check', label: 'Check homework they can give: mark done, grade, remark, send back to redo' },
    { resource: 'homework', action: 'view', label: 'See homework and the homework diary', description: 'Assigned = the sections they teach or are class teacher of.', scopes: ['all', 'assigned'] },
    { resource: 'homework', action: 'mine', label: 'See their own (or their children’s) homework and hand it in' },
]);

registerMenuGroup({ key: 'homework', label: 'Homework', order: 14 });
registerMenuItems([
    { key: 'homework', label: 'Homework', icon: 'menu_book', href: '/homework', group: 'homework', order: 10, anyPermission: ['homework.give', 'homework.view'] },
    { key: 'homework-diary', label: 'Homework Diary', icon: 'calendar_month', href: '/homework/diary', group: 'homework', order: 20, permission: 'homework.view' },
    { key: 'my-homework', label: 'My Homework', icon: 'menu_book', href: '/my-homework', group: 'main', order: 26, permission: 'homework.mine' },
]);

registerMasterUsage('homework_type', { label: 'homework', count: (ids) => db.homework.count({ where: { typeId: { in: ids } } }) });
registerMasterUsage('homework_grade', { label: 'checked homework', count: (ids) => db.homeworkSubmission.count({ where: { gradeId: { in: ids } } }) });
