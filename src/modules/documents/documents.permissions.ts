import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';

registerPermissions({ key: 'documents', label: 'Documents', order: 88 }, [{ resource: 'documents', action: 'manage', label: 'Change document templates (receipts, slips, certificates…)' }]);

registerMenuItems([{ key: 'document-templates', label: 'Document Templates', icon: 'description', href: '/documents', group: 'setup', order: 35, permission: 'documents.manage' }]);
