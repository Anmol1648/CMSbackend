import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './feedback.settings';

registerPermissions({ key: 'feedback', label: 'Teacher Feedback', order: 54 }, [
    { resource: 'feedback', action: 'manage', label: 'Make question sets, open and close feedback rounds, screen comments, release results' },
    { resource: 'feedback', action: 'results', label: 'See every teacher’s feedback results and the reports' },
    { resource: 'feedback', action: 'own', label: 'See their own feedback results (when the school releases them)' },
    { resource: 'feedback', action: 'give', label: 'Fill in feedback forms about their (or their children’s) teachers' },
]);

registerMenuGroup({ key: 'feedback', label: 'Teacher Feedback', order: 22 });
registerMenuItems([
    { key: 'feedback-rounds', app: false, label: 'Feedback Rounds', icon: 'rate_review', href: '/feedback', group: 'feedback', order: 10, permission: 'feedback.manage' },
    { key: 'feedback-results', label: 'Feedback Results', icon: 'insights', href: '/feedback/results', group: 'feedback', order: 20, permission: 'feedback.results' },
    { key: 'feedback-own', label: 'My Feedback', icon: 'insights', href: '/feedback/mine', group: 'main', order: 35, permission: 'feedback.own' },
    { key: 'feedback-give', label: 'Teacher Feedback', icon: 'rate_review', href: '/my-feedback', group: 'main', order: 35, permission: 'feedback.give' },
]);
