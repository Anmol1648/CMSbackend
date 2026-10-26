import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import { auditModel, db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './admissions.settings';
import './admissions.masters';

registerPermissions({ key: 'admissions', label: 'Admissions', order: 28 }, [
    { resource: 'enquiry', action: 'view', label: 'See admission enquiries', description: 'Own = only the enquiries they follow up.', scopes: ['all', 'own'] },
    { resource: 'enquiry', action: 'manage', label: 'Add and edit enquiries, follow-ups, registration and test results' },
    { resource: 'enquiry', action: 'convert', label: 'Convert an enquiry into an admission', description: 'Also needs "Admit students".' },
    { resource: 'enquiry', action: 'reports', label: 'See the admission reports' },
]);

registerMenuGroup({ key: 'admissions', label: 'Admissions', order: 5 });
registerMenuItems([
    { key: 'enquiries', label: 'Enquiries', icon: 'contact_phone', href: '/admissions', group: 'admissions', order: 10, permission: 'enquiry.view' },
    { key: 'admission-reports', app: false, label: 'Admission Reports', icon: 'query_stats', href: '/admissions/reports', group: 'admissions', order: 20, permission: 'enquiry.reports' },
]);

auditModel('Enquiry', 'enquiry');

for (const [master, column] of [
    ['gender', 'genderId'],
    ['relation', 'relationId'],
    ['enquiry_source', 'sourceId'],
    ['enquiry_stage', 'stageId'],
    ['enquiry_lost_reason', 'lostReasonId'],
] as const) {
    registerMasterUsage(master, { label: 'enquiries', count: (ids) => db.enquiry.count({ where: { [column]: { in: ids } } }) });
}
registerMasterUsage('follow_up_outcome', { label: 'follow-ups', count: (ids) => db.enquiryFollowUp.count({ where: { outcomeId: { in: ids } } }) });
