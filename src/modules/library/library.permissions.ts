import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './library.settings';

registerPermissions({ key: 'library', label: 'Library', order: 44 }, [
    { resource: 'library', action: 'view', label: 'See the catalogue, the copies and who has which book' },
    { resource: 'library', action: 'manage', label: 'Add and change books and copies, import them, print labels, run stock checks' },
    { resource: 'library', action: 'issue', label: 'Run the counter: issue, return and renew books, reserve for members' },
    { resource: 'library', action: 'fines', label: 'Waive fines, take fines at the counter, mark books lost or damaged' },
    { resource: 'library', action: 'mine', label: 'My Library: their own (or their children’s) books and fines, search, reserve and renew' },
]);

registerMenuGroup({ key: 'library', label: 'Library', order: 17 });
registerMenuItems([
    { key: 'library-counter', label: 'Issue & Return', icon: 'qr_code_scanner', href: '/library', group: 'library', order: 10, permission: 'library.issue' },
    { key: 'library-books', label: 'Books', icon: 'local_library', href: '/library/books', group: 'library', order: 20, anyPermission: ['library.view', 'library.manage'] },
    { key: 'library-loans', label: 'Books Out', icon: 'outbox', href: '/library/loans', group: 'library', order: 30, anyPermission: ['library.view', 'library.issue'] },
    { key: 'library-fines', label: 'Fines', icon: 'payments', href: '/library/fines', group: 'library', order: 40, anyPermission: ['library.view', 'library.fines'] },
    { key: 'library-reservations', label: 'Reservations', icon: 'bookmark', href: '/library/reservations', group: 'library', order: 50, anyPermission: ['library.view', 'library.issue'] },
    { key: 'library-stock', label: 'Stock Check', icon: 'inventory', href: '/library/stock', group: 'library', order: 60, permission: 'library.manage' },
    { key: 'my-library', label: 'My Library', icon: 'local_library', href: '/my-library', group: 'main', order: 30, permission: 'library.mine' },
]);

registerMasterUsage('library_category', { label: 'books', count: (ids) => db.book.count({ where: { categoryId: { in: ids } } }) });
registerMasterUsage('library_language', { label: 'books', count: (ids) => db.book.count({ where: { languageId: { in: ids } } }) });
registerMasterUsage('library_location', { label: 'books or copies', count: async (ids) => (await db.book.count({ where: { locationId: { in: ids } } })) + (await db.bookCopy.count({ where: { locationId: { in: ids } } })) });
registerMasterUsage('book_condition', { label: 'copies', count: (ids) => db.bookCopy.count({ where: { conditionId: { in: ids } } }) });
