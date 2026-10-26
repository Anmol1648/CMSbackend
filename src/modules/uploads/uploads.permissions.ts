import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './uploads.settings';

registerPermissions({ key: 'upload', label: 'Shared Files', order: 56 }, [
    { resource: 'upload', action: 'manage', label: 'Make folders, share files with anyone, set who sees them, approve and delete' },
    { resource: 'upload', action: 'add', label: 'Add files to folders open to teachers, for the sections they teach' },
    { resource: 'upload', action: 'view', label: 'See and download the files shared with them (Downloads)' },
    { resource: 'upload', action: 'reports', label: 'See who opened and acknowledged shared files' },
]);

registerMenuGroup({ key: 'shared', label: 'Shared Files', order: 23 });
registerMenuItems([
    { key: 'shared-manage', app: false, label: 'File Library', icon: 'folder_shared', href: '/files', group: 'shared', order: 10, anyPermission: ['upload.manage', 'upload.add'] },
    { key: 'shared-downloads', label: 'Downloads', icon: 'download', href: '/downloads', group: 'main', order: 36, permission: 'upload.view' },
]);

registerMasterUsage('upload_tag', { label: 'files', count: (ids) => db.uploadItem.count({ where: { tagIds: { hasSome: ids } } }) });
