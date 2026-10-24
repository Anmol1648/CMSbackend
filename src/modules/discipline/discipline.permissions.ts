import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './discipline.settings';

registerPermissions({ key: 'discipline', label: 'Discipline', order: 52 }, [
    { resource: 'discipline', action: 'record', label: 'Record incidents and positive notes', description: 'Assigned = students of the sections they teach or are class teacher of (unless System Settings → Discipline lets teachers record for anyone).', scopes: ['all', 'assigned'] },
    { resource: 'discipline', action: 'view', label: 'See incidents and students’ conduct', description: 'Assigned = the sections they teach or are class teacher of.', scopes: ['all', 'assigned'] },
    { resource: 'discipline', action: 'action', label: 'Decide actions (warning, detention, suspension…) and settle incidents' },
    { resource: 'discipline', action: 'approve', label: 'Approve or refuse actions that need approval (e.g. suspension)' },
    { resource: 'discipline', action: 'mine', label: 'See their own (or their children’s) conduct and acknowledge it' },
]);

registerMenuGroup({ key: 'discipline', label: 'Discipline', order: 21 });
registerMenuItems([
    { key: 'discipline-list', label: 'Discipline', icon: 'gavel', href: '/discipline', group: 'discipline', order: 10, anyPermission: ['discipline.view', 'discipline.record'] },
    { key: 'discipline-mine', label: 'Conduct', icon: 'verified', href: '/my-conduct', group: 'main', order: 34, permission: 'discipline.mine' },
]);

registerMasterUsage('incident_type', { label: 'incidents', count: (ids) => db.incident.count({ where: { typeId: { in: ids } } }) });
registerMasterUsage('discipline_action', { label: 'actions', count: (ids) => db.incidentAction.count({ where: { actionId: { in: ids } } }) });
registerMasterUsage('incident_place', { label: 'incidents', count: (ids) => db.incident.count({ where: { placeId: { in: ids } } }) });
