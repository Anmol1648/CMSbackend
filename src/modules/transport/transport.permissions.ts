import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './transport.settings';

registerPermissions({ key: 'transport', label: 'Transport', order: 42 }, [
    { resource: 'transport', action: 'view', label: 'See routes, stops, vehicles and who uses the bus' },
    { resource: 'transport', action: 'manage', label: 'Set up transport: vehicles and their papers, routes, stops, students’ routes and stops' },
    { resource: 'transport', action: 'track_all', label: 'See every bus live on the map, and the trips’ history' },
    { resource: 'transport', action: 'drive', label: 'Run trips of the routes they drive or help on (the trip screen sends the bus’s position)' },
    { resource: 'transport', action: 'setup', label: 'Connect GPS devices and Google Maps (their keys)' },
    { resource: 'transport', action: 'track_mine', label: 'See their own (or their children’s) bus live, and its alerts' },
]);

registerMenuGroup({ key: 'transport', label: 'Transport', order: 16 });
registerMenuItems([
    { key: 'transport-live', label: 'Live Map', icon: 'map', href: '/transport', group: 'transport', order: 10, permission: 'transport.track_all' },
    { key: 'transport-routes', label: 'Routes & Stops', icon: 'route', href: '/transport/routes', group: 'transport', order: 20, anyPermission: ['transport.view', 'transport.manage'] },
    { key: 'transport-students', label: 'Students’ Transport', icon: 'airline_seat_recline_normal', href: '/transport/students', group: 'transport', order: 30, anyPermission: ['transport.view', 'transport.manage'] },
    { key: 'transport-vehicles', label: 'Vehicles', icon: 'directions_bus', href: '/transport/vehicles', group: 'transport', order: 40, anyPermission: ['transport.view', 'transport.manage'] },
    { key: 'transport-trips', label: 'Trips', icon: 'history', href: '/transport/trips', group: 'transport', order: 50, permission: 'transport.track_all' },
    { key: 'transport-setup', label: 'GPS & Maps', icon: 'satellite_alt', href: '/transport/setup', group: 'transport', order: 60, permission: 'transport.setup' },
    { key: 'transport-drive', label: 'My Trip', icon: 'navigation', href: '/transport/drive', group: 'main', order: 29, permission: 'transport.drive' },
    { key: 'transport-mine', label: 'My Bus', icon: 'directions_bus', href: '/my-bus', group: 'main', order: 29, permission: 'transport.track_mine' },
]);

registerMasterUsage('vehicle_type', { label: 'vehicles', count: (ids) => db.vehicle.count({ where: { typeId: { in: ids } } }) });
registerMasterUsage('vehicle_document', { label: 'vehicle papers', count: (ids) => db.vehicleDocument.count({ where: { typeId: { in: ids } } }) });
