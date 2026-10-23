import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import './learn.settings';

registerPermissions({ key: 'learn', label: 'AI Learning', order: 41 }, [
    { resource: 'learn', action: 'use', label: 'Learn with the AI tutor: ask about a chapter, explanations, practice quizzes (students)' },
    { resource: 'learn', action: 'view', label: 'See students’ AI learning: practice scores, chapters practised, conversations', description: 'Assigned = students of their sections; Own = their own children.', scopes: ['all', 'assigned', 'own'] },
]);

registerMenuItems([
    { key: 'learn', label: 'AI Learning', icon: 'school', href: '/learn', group: 'main', order: 28, permission: 'learn.use' },
    { key: 'learn-progress', label: 'AI Learning Progress', icon: 'insights', href: '/learn/progress', group: 'learning', order: 40, permission: 'learn.view' },
]);
