import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './idcards.settings';

registerPermissions({ key: 'idcard', label: 'ID cards', order: 59 }, [
    { resource: 'idcard', action: 'design', label: 'Make and change ID card designs' },
    { resource: 'idcard', action: 'print', label: 'Print ID cards, issue duplicates, approve photos from parents' },
    { resource: 'idcard', action: 'view', label: 'See the cards given and the ID card reports' },
    { resource: 'idcard', action: 'photos', label: 'Take students’ photos for the cards', description: 'Assigned = the sections they are class teacher of.', scopes: ['all', 'assigned'] },
    { resource: 'idcard', action: 'verify', label: 'Scan an ID card to check it is valid (gate, library, bus)' },
    { resource: 'idcard', action: 'mine', label: 'See their own (or their child’s) ID card' },
]);

registerMenuGroup({ key: 'idcards', label: 'ID Cards', order: 25 });
registerMenuItems([
    { key: 'idcards-print', label: 'Print ID Cards', icon: 'badge', href: '/id-cards', group: 'idcards', order: 10, permission: 'idcard.print' },
    { key: 'idcards-issued', label: 'Cards Given', icon: 'contact_page', href: '/id-cards/issued', group: 'idcards', order: 20, anyPermission: ['idcard.print', 'idcard.view'] },
    { key: 'idcards-photos', label: 'Photos for Cards', icon: 'photo_camera', href: '/id-cards/photos', group: 'idcards', order: 30, anyPermission: ['idcard.photos', 'idcard.print'] },
    { key: 'idcards-designs', label: 'Card Designs', icon: 'design_services', href: '/id-cards/designs', group: 'idcards', order: 40, permission: 'idcard.design' },
    { key: 'idcards-verify', label: 'Check an ID Card', icon: 'qr_code_scanner', href: '/id-cards/verify', group: 'idcards', order: 50, permission: 'idcard.verify' },
    { key: 'idcards-mine', label: 'My ID Card', icon: 'badge', href: '/my-id-card', group: 'main', order: 38, permission: 'idcard.mine' },
]);
