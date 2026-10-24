import { defineAlert } from '../alerts/alerts.registry';

/** Shared file alerts (Alerts → Built-in Alerts). */

const audience = [{ key: 'audience', label: 'Those who can see the file' }];
const base = [
    { key: 'title', label: 'File', example: 'Class VII syllabus 2026–27' },
    { key: 'folder', label: 'Folder', example: 'Syllabus' },
];

defineAlert({ key: 'shared_new', label: 'New shared file', description: 'When a file is shared (or a new version) and the person sharing ticks “tell them now”.', type: 'notices', when: 'instant', recipients: audience, fields: [...base, { key: 'ack', label: 'Acknowledgement line', example: 'Please open it and confirm you have read it.' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['audience'], subject: 'New in {{folder}}: {{title}}', body: 'Dear {{name}},\n\n“{{title}}” was shared in {{folder}} on Downloads. {{ack}}', shortText: '{{school}}: new file “{{title}}” on Downloads.' }, link: '/downloads' });
defineAlert({ key: 'shared_ack_reminder', label: 'Please acknowledge a file', description: 'Daily, some days after a file that must be acknowledged was shared (System Settings → Shared files): once per person.', type: 'notices', when: 'daily', recipients: audience, fields: base, defaults: { enabled: true, channels: ['in_app'], recipients: ['audience'], priority: 'important', subject: 'Please read: {{title}}', body: 'Dear {{name}},\n\nPlease open “{{title}}” ({{folder}}) on Downloads and confirm you have read it.', shortText: '{{school}}: please read “{{title}}” on Downloads.' }, link: '/downloads' });
