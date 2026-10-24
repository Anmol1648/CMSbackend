import { defineAlert } from '../alerts/alerts.registry';

/** Teacher feedback alerts (Alerts → Built-in Alerts). */

const families = [
    { key: 'student', label: 'Students' },
    { key: 'parent', label: 'Parents' },
];
const base = [
    { key: 'round', label: 'Round', example: 'Feedback on teachers: Term 1' },
    { key: 'closes', label: 'Closes on', example: '30 Oct' },
];

defineAlert({ key: 'feedback_open', label: 'Teacher feedback is open', description: 'When a feedback round opens: to the students and / or parents asked.', type: 'notices', when: 'instant', recipients: families, fields: [...base, { key: 'anonymous', label: 'Anonymity line', example: 'Your answers are anonymous: no one sees who wrote what.' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['student', 'parent'], subject: 'Tell us about your teachers', body: 'Dear {{name}},\n\n{{round}} is open until {{closes}}. It takes a few minutes per teacher. {{anonymous}}', shortText: '{{school}}: teacher feedback open till {{closes}}.' }, link: '/my-feedback' });
defineAlert({ key: 'feedback_reminder', label: 'Teacher feedback reminder', description: 'Days before a round closes (System Settings → Teacher feedback): to those who haven’t filled every form.', type: 'notices', when: 'daily', recipients: families, fields: base, defaults: { enabled: true, channels: ['in_app'], recipients: ['student', 'parent'], subject: 'Teacher feedback closes {{closes}}', body: 'Dear {{name}},\n\nYou still have teacher feedback to fill in for {{round}}. It closes on {{closes}}.', shortText: '{{school}}: teacher feedback closes {{closes}}.' }, link: '/my-feedback' });
defineAlert({ key: 'feedback_results', label: 'Your feedback results are ready', description: 'When a round’s results are released to teachers.', type: 'notices', when: 'instant', recipients: [{ key: 'teacher', label: 'Teachers with feedback' }], fields: [{ key: 'round', label: 'Round', example: 'Feedback on teachers: Term 1' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['teacher'], subject: 'Your feedback results: {{round}}', body: 'Dear {{name}},\n\nThe results of {{round}} are on My Feedback.', shortText: 'Your feedback results are ready.' }, link: '/feedback/mine' });
