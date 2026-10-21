import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import { registerReportCategory } from './reports.registry';

registerPermissions({ key: 'reports', label: 'Report Center', order: 87 }, [
    { resource: 'report', action: 'view', label: 'Open the Report Center', description: 'Each report also needs its own permission (fee reports, admission reports…).' },
    { resource: 'report', action: 'build', label: 'Make their own reports (Report Builder) and share them with roles', description: 'They only see data their other permissions allow.' },
    {
        resource: 'report',
        action: 'design',
        label: 'Upload Jasper designs for reports and choose how reports are made',
        description: 'A Jasper design can run code on the report server: give this only to people you trust with the system.',
        sensitive: true,
    },
]);

registerMenuItems([{ key: 'report-center', label: 'Report Center', icon: 'summarize', href: '/reports', group: 'main', order: 30, permission: 'report.view' }]);

registerReportCategory('Students', 5);
registerReportCategory('Attendance', 8);
registerReportCategory('Fees', 10);
registerReportCategory('Admissions', 20);
registerReportCategory('Timetable', 30);
registerReportCategory('Staff', 40);
registerReportCategory('My reports', 100);
