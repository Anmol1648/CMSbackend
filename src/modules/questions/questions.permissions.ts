import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuItems } from '../../core/registry/menu';
import { db } from '../../core/db';
import { registerMasterUsage } from '../masters/masters.registry';
import './questions.settings';
import './questions.imports';

registerPermissions({ key: 'questions', label: 'Syllabus & Question Bank', order: 39 }, [
    { resource: 'syllabus', action: 'manage', label: 'Set up the chapters of subjects', description: 'Assigned = the subjects they teach (and every subject of their own class).', scopes: ['all', 'assigned'] },
    { resource: 'question', action: 'view', label: 'See the question bank', description: 'Assigned = the subjects they teach.', scopes: ['all', 'assigned'] },
    { resource: 'question', action: 'add', label: 'Add and change questions', description: 'Assigned = the subjects they teach.', scopes: ['all', 'assigned'] },
    { resource: 'question', action: 'approve', label: 'Review questions: approve or send back' },
]);

registerMenuItems([
    { key: 'question-bank', label: 'Question Bank', icon: 'quiz', href: '/questions', group: 'learning', order: 20, anyPermission: ['question.view', 'question.add', 'question.approve'] },
    { key: 'syllabus', label: 'Chapters', icon: 'library_books', href: '/questions/chapters', group: 'learning', order: 10, anyPermission: ['syllabus.manage', 'question.add'] },
]);

registerMasterUsage('question_difficulty', { label: 'questions', count: (ids) => db.question.count({ where: { difficultyId: { in: ids } } }) });
registerMasterUsage('question_level', { label: 'questions', count: (ids) => db.question.count({ where: { levelId: { in: ids } } }) });
