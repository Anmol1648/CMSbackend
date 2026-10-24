import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './exams.settings';
import './exams2.settings';
import './exams.labels';

registerPermissions({ key: 'exams', label: 'Exams', order: 34 }, [
    { resource: 'exam', action: 'setup', label: 'Set up exams: terms, exams, date sheets, grading scales and result rules' },
    { resource: 'exam', action: 'marks', label: 'Enter the marks of the subjects they teach (and, as class teacher, co-scholastic grades and remarks)' },
    { resource: 'exam', action: 'marks_class', label: 'As class teacher, enter the marks of every subject of their own section (not only the subjects they teach)' },
    { resource: 'exam', action: 'marks_any', label: 'Enter marks of any section and subject (office)' },
    { resource: 'exam', action: 'moderate', label: 'Change marks after entry is locked (principal); every change is recorded' },
    { resource: 'exam', action: 'publish', label: 'Publish results and report cards to students and parents' },
    { resource: 'exam', action: 'view', label: 'See results and report cards', description: 'Assigned = their own class in full, and only their subject in the other sections they teach.', scopes: ['all', 'assigned'] },
    { resource: 'exam', action: 'view_taught_sections', label: 'See the full result of every section they teach, not only their subject (e.g. a coordinator)' },
    { resource: 'exam', action: 'mine', label: 'See their own (or their children’s) published results' },
    { resource: 'exam', action: 'admit', label: 'Print admit cards (and give one although fees are due)' },
    { resource: 'exam', action: 'seating', label: 'Make seating plans and invigilation duties' },
    { resource: 'exam', action: 'papers', label: 'See and make every question paper (teachers make their own subject’s with exam.marks)' },
    { resource: 'exam', action: 'recheck', label: 'Decide re-check requests (and change the marks)' },
    { resource: 'exam', action: 'analysis', label: 'See the result analysis of the whole school' },
]);

registerMenuGroup({ key: 'exams', label: 'Exams', order: 13 });
registerMenuItems([
    { key: 'exam-marks', label: 'Enter Marks', icon: 'edit_square', href: '/exams/marks', group: 'exams', order: 10, anyPermission: ['exam.marks', 'exam.marks_any'] },
    { key: 'exam-results', label: 'Results & Report Cards', icon: 'grading', href: '/exams/results', group: 'exams', order: 20, permission: 'exam.view' },
    { key: 'exam-list', label: 'Exams & Date Sheets', icon: 'event_note', href: '/exams', group: 'exams', order: 30, permission: 'exam.setup' },
    { key: 'exam-setup', label: 'Grading & Result Rules', icon: 'rule', href: '/exams/setup', group: 'exams', order: 40, permission: 'exam.setup' },
    { key: 'exam-admit', label: 'Admit Cards & Seating', icon: 'event_seat', href: '/exams/hall', group: 'exams', order: 32, anyPermission: ['exam.admit', 'exam.seating'] },
    { key: 'exam-papers', label: 'Question Papers', icon: 'description', href: '/exams/papers', group: 'exams', order: 34, anyPermission: ['exam.papers', 'exam.marks'] },
    { key: 'exam-analysis', label: 'Result Analysis', icon: 'monitoring', href: '/exams/analysis', group: 'exams', order: 25, anyPermission: ['exam.analysis', 'exam.view'] },
    { key: 'exam-after', label: 'Re-checks & Supplementary', icon: 'restart_alt', href: '/exams/after', group: 'exams', order: 36, anyPermission: ['exam.recheck', 'exam.setup', 'exam.marks'] },
    { key: 'my-duties', label: 'My Invigilation', icon: 'supervisor_account', href: '/my-duties', group: 'main', order: 28, anyPermission: ['exam.marks', 'exam.marks_any'] },
    { key: 'my-results', label: 'My Results', icon: 'workspace_premium', href: '/my-results', group: 'main', order: 27, permission: 'exam.mine' },
]);
