import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './alerts.settings';
import './jobs';
import './messages.service';

registerPermissions({ key: 'messaging', label: 'Messages & Alerts', order: 38 }, [
    { resource: 'message', action: 'send', label: 'Write and send messages (Compose)', description: 'Assigned = only to the students and parents of the sections they teach or are class teacher of.', scopes: ['all', 'assigned'] },
    { resource: 'message', action: 'send_groups', label: 'Send to whole-school groups (all parents, all staff, roles)' },
    { resource: 'message', action: 'attach_documents', label: 'Attach ERP documents to messages (each child’s report card)' },
    { resource: 'message', action: 'schedule', label: 'Schedule messages for later' },
    { resource: 'message', action: 'sms_whatsapp', label: 'Send by SMS and WhatsApp (these cost money)' },
    { resource: 'message', action: 'view_sent', label: 'See sent messages and who got them', description: 'Own = the messages they sent.', scopes: ['all', 'own'] },
    { resource: 'alert', action: 'setup', label: 'Set up alerts: turn built-in alerts on or off, their wording, channels and provider keys' },
    { resource: 'alert', action: 'custom', label: 'Create alerts from reports (sent on a schedule)' },
    { resource: 'alert', action: 'log', label: 'See the alert log (every message sent, failed or skipped)', description: 'Assigned = messages about their own sections.', scopes: ['all', 'assigned'] },
    { resource: 'alert', action: 'templates', label: 'Manage saved message templates' },
]);

registerMenuGroup({ key: 'messaging', label: 'Messages & Alerts', order: 12 });
registerMenuItems([
    // Everyone's own notifications.
    { key: 'notifications', label: 'Notifications', icon: 'notifications', href: '/notifications', group: 'main', order: 5 },
    { key: 'compose', label: 'Compose', icon: 'edit', href: '/messages/compose', group: 'messaging', order: 10, permission: 'message.send' },
    { key: 'messages-sent', label: 'Sent Messages', icon: 'outbox', href: '/messages', group: 'messaging', order: 20, anyPermission: ['message.send', 'message.view_sent'] },
    { key: 'message-templates', label: 'Message Templates', icon: 'article', href: '/messages/templates', group: 'messaging', order: 30, permission: 'alert.templates' },
    { key: 'alerts-builtin', label: 'Built-in Alerts', icon: 'notifications_active', href: '/alerts', group: 'messaging', order: 40, permission: 'alert.setup' },
    { key: 'alerts-log', label: 'Alert Log', icon: 'receipt_long', href: '/alerts/log', group: 'messaging', order: 60, permission: 'alert.log' },
    { key: 'alerts-channels', label: 'Channels', icon: 'cell_tower', href: '/alerts/channels', group: 'messaging', order: 70, permission: 'alert.setup' },
]);

registerMasterUsage('message_category', {
    label: 'messages and templates',
    count: async (ids) => (await db.message.count({ where: { categoryId: { in: ids } } })) + (await db.messageTemplate.count({ where: { categoryId: { in: ids } } })),
});
