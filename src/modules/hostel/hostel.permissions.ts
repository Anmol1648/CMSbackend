import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './hostel.settings';

registerPermissions({ key: 'hostel', label: 'Hostel', order: 63 }, [
    { resource: 'hostel', action: 'setup', label: 'Set up hostels, rooms and wardens' },
    { resource: 'hostel', action: 'allot', label: 'Allot, move and vacate beds' },
    { resource: 'hostel', action: 'warden', label: 'Run the hostel: roll call, leave passes, sick bay, inspections and fines', description: 'Assigned = only the hostels they are warden of.', scopes: ['all', 'assigned'] },
    { resource: 'hostel', action: 'view', label: 'See hostels, boarders and hostel reports' },
    { resource: 'hostel', action: 'gate', label: 'Scan boarders’ leave passes out and in at the gate' },
    { resource: 'hostel', action: 'mine', label: 'See their (child’s) room, attendance and leave; ask for leave' },
]);

registerMenuGroup({ key: 'hostel', label: 'Hostel', order: 29 });
registerMenuItems([
    { key: 'hostel-rooms', label: 'Rooms & Boarders', icon: 'bed', href: '/hostel', group: 'hostel', order: 10, anyPermission: ['hostel.allot', 'hostel.view', 'hostel.warden', 'hostel.setup'] },
    { key: 'hostel-roll', label: 'Roll Call', icon: 'how_to_reg', href: '/hostel/roll-call', group: 'hostel', order: 20, permission: 'hostel.warden' },
    { key: 'hostel-leave', label: 'Leave & Passes', icon: 'directions_walk', href: '/hostel/leave', group: 'hostel', order: 30, anyPermission: ['hostel.warden', 'hostel.view'] },
    { key: 'hostel-care', label: 'Sick Bay & Inspections', icon: 'medical_services', href: '/hostel/care', group: 'hostel', order: 40, permission: 'hostel.warden' },
    { key: 'hostel-gate', label: 'Hostel Gate', icon: 'qr_code_scanner', href: '/hostel/gate', group: 'hostel', order: 50, permission: 'hostel.gate' },
    { key: 'hostel-mine', label: 'My Hostel', icon: 'bed', href: '/my-hostel', group: 'main', order: 41, permission: 'hostel.mine' },
]);

registerMasterUsage('hostel_room_type', { label: 'rooms', count: (ids) => db.hostelRoom.count({ where: { roomTypeId: { in: ids } } }) });
