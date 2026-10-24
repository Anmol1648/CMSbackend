import { defineAlert } from '../alerts/alerts.registry';

/** Mess alerts (Alerts → Built-in Alerts). */

const managers = [{ key: 'managers', label: 'Those who run the mess' }];

defineAlert({ key: 'mess_headcount', label: 'Today’s mess headcount', description: 'Every morning: how many to cook for at each meal (members less skipped meals and boarders on leave).', type: 'mess', when: 'daily', recipients: managers, fields: [{ key: 'date', label: 'Date', example: '2026-10-24' }, { key: 'list', label: 'Meals', example: '- Lunch: 64 (members 70, skipped 4, away 2)' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['managers'], subject: 'Mess headcount for {{date}}', body: 'To cook for on {{date}}:\n{{list}}', shortText: 'Mess headcount for {{date}} is ready.' }, link: '/mess' });
defineAlert({ key: 'mess_low_rating', label: 'A meal rated low', description: 'When at least five people rate a meal 2.5 stars or less on average.', type: 'mess', when: 'instant', recipients: managers, fields: [{ key: 'meal', label: 'Meal', example: 'Dinner' }, { key: 'date', label: 'Date', example: '2026-10-24' }, { key: 'rating', label: 'Average', example: '2.2' }, { key: 'count', label: 'Ratings', example: '7' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['managers'], subject: '{{meal}} on {{date}} rated {{rating}}★', body: '{{count}} people rated {{meal}} on {{date}} at {{rating}} stars on average.', shortText: '{{meal}} ({{date}}) rated {{rating}}★' }, link: '/mess' });
