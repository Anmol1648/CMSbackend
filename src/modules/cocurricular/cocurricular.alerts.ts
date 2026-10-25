import { defineAlert } from '../alerts/alerts.registry';

/** Co-curricular alerts (Alerts → Built-in Alerts). Results alerts can be switched off in System Settings → Co-curricular. */

const families = [
    { key: 'parent', label: 'Parents' },
    { key: 'student', label: 'Students' },
];

defineAlert({
    key: 'club_request',
    label: 'Request to join a club',
    description: 'When a student or parent asks to join a club: to its teachers in-charge.',
    type: 'notices',
    when: 'instant',
    recipients: [{ key: 'incharge', label: 'Teachers in-charge of the club' }],
    fields: [
        { key: 'club', label: 'Club', example: 'Eco Club' },
        { key: 'student', label: 'Student', example: 'Shubham Nautiyal' },
        { key: 'section', label: 'Class', example: 'VII-B' },
        { key: 'note', label: 'Their note', example: 'I like planting trees.' },
    ],
    defaults: { enabled: true, channels: ['in_app'], recipients: ['incharge'], subject: '{{student}} ({{section}}) asks to join {{club}}', body: '{{student}} of {{section}} asked to join {{club}}. {{note}}\n\nAccept or refuse on the club’s page.', shortText: '{{student}} asks to join {{club}}.' },
    link: '/clubs',
});

defineAlert({
    key: 'club_request_answered',
    label: 'Club request answered',
    description: 'When the teacher in-charge accepts or refuses a request to join a club.',
    type: 'notices',
    when: 'instant',
    recipients: families,
    fields: [
        { key: 'club', label: 'Club', example: 'Eco Club' },
        { key: 'student', label: 'Student', example: 'Shubham Nautiyal' },
        { key: 'answer', label: 'Answer', example: 'accepted' },
    ],
    defaults: { enabled: true, channels: ['in_app'], recipients: ['parent', 'student'], subject: '{{club}}: {{answer}}', body: 'Dear {{name}},\n\nThe request for {{student}} to join {{club}} was {{answer}}.', shortText: '{{school}}: {{student}}, {{club}}: {{answer}}.' },
    link: '/my-activities',
});

defineAlert({
    key: 'competition_result',
    label: 'Competition result',
    description: 'When the results of a competition a student took part in are shown to families.',
    type: 'notices',
    when: 'instant',
    recipients: families,
    fields: [
        { key: 'competition', label: 'Competition', example: 'Inter-house debate' },
        { key: 'result', label: 'Result', example: '1st place (Best speaker)' },
        { key: 'date', label: 'Date', example: '2026-10-20' },
    ],
    defaults: { enabled: true, channels: ['in_app'], recipients: ['parent', 'student'], subject: '{{competition}}: {{result}}', body: 'Dear {{name}},\n\nResult of {{competition}} ({{date}}): {{result}}. Congratulations! 🏆', shortText: '{{school}}: {{competition}}: {{result}}.' },
    link: '/my-activities',
});
