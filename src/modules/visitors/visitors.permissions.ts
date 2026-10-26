import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './visitors.settings';

registerPermissions({ key: 'visitor', label: 'Visitors & Pickups', order: 48 }, [
    { resource: 'visitor', action: 'gate', label: 'Run the gate: let visitors in (photo, pass), check them out, hand over students collected early' },
    { resource: 'visitor', action: 'view', label: 'See the visitor log, early pickups and their reports' },
    { resource: 'visitor', action: 'manage', label: 'Blacklist visitors, approve a pickup by someone not on the list, edit students’ pickup lists' },
    { resource: 'visitor', action: 'expect', label: 'Tell the gate about their own expected visitors, and allow or refuse visitors who come to meet them' },
    { resource: 'visitor', action: 'pickup_mine', label: 'Manage who may collect their own children (My Pickup List)' },
]);

registerMenuGroup({ key: 'visitors', label: 'Visitors', order: 19 });
registerMenuItems([
    { key: 'visitor-gate', label: 'Gate', icon: 'door_front', href: '/visitors', group: 'visitors', order: 10, permission: 'visitor.gate' },
    { key: 'visitor-pickup', label: 'Student Pickup', icon: 'escalator_warning', href: '/visitors/pickup', group: 'visitors', order: 20, anyPermission: ['visitor.gate', 'visitor.manage'] },
    { key: 'visitor-log', label: 'Visitor Log', icon: 'list_alt', href: '/visitors/log', group: 'visitors', order: 30, permission: 'visitor.view' },
    { key: 'visitor-blacklist', app: false, label: 'Blacklist', icon: 'block', href: '/visitors/blacklist', group: 'visitors', order: 40, permission: 'visitor.manage' },
    { key: 'visitor-mine', label: 'My Visitors', icon: 'door_front', href: '/visitors/mine', group: 'main', order: 32, permission: 'visitor.expect' },
    { key: 'pickup-mine', label: 'My Pickup List', icon: 'escalator_warning', href: '/my-pickup', group: 'main', order: 32, permission: 'visitor.pickup_mine' },
]);

registerMasterUsage('visit_purpose', { label: 'visits', count: (ids) => db.visit.count({ where: { purposeId: { in: ids } } }) });
registerMasterUsage('visitor_id_type', { label: 'visitors', count: (ids) => db.visitor.count({ where: { idTypeId: { in: ids } } }) });
registerMasterUsage('pickup_relation', { label: 'pickup people', count: (ids) => db.pickupPerson.count({ where: { relationId: { in: ids } } }) });
