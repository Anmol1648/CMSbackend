import { db } from '../../core/db';
import { defineAlert } from '../alerts/alerts.registry';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, parentsOf } from '../alerts/recipients';
import { fmtDate } from '../alerts/format';
import { fullName } from '../students/students.service';

/** Transfer certificate alerts: asked for (to the office), issued (to the parents). */

const fields = [
    { key: 'student', label: 'Student', example: 'Manish Rana' },
    { key: 'leavingDate', label: 'Leaving date', example: '31 Mar 2027' },
];

defineAlert({
    key: 'tc_requested',
    label: 'TC asked for',
    description: 'When a transfer certificate is asked for: to those who handle TCs, to clear and issue it.',
    type: 'students',
    when: 'instant',
    recipients: [{ key: 'office', label: 'Those who handle TCs' }],
    fields,
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['office'],
        subject: 'TC asked for: {{student}}',
        body: 'A transfer certificate has been asked for {{student}}, leaving on {{leavingDate}}. Clear the dues and issue it under Students → Transfer Certificates.',
        shortText: '{{school}}: TC asked for {{student}} (leaving {{leavingDate}}).',
    },
    link: '/students/tc',
});

defineAlert({
    key: 'tc_issued',
    label: 'TC issued',
    description: 'When a transfer certificate is issued: to the parents.',
    type: 'students',
    when: 'instant',
    recipients: [{ key: 'parent', label: 'Parents' }],
    fields: [...fields, { key: 'tcNo', label: 'TC number', example: 'TC/2026/015' }],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent'],
        subject: 'Transfer certificate of {{student}} is ready',
        body: 'Dear {{name}},\n\nThe transfer certificate of {{student}} (no. {{tcNo}}) is ready. Please collect it from the school office.',
        shortText: '{{school}}: TC of {{student}} (no. {{tcNo}}) is ready to collect.',
    },
});

const loadTc = (id: string) => db.transferCertificate.findFirst({ where: { id }, select: { id: true, tcNo: true, leavingDate: true, studentId: true, student: { select: { firstName: true, middleName: true, lastName: true } } } });

export const alertTc = (id: string, what: 'requested' | 'issued') => {
    void (async () => {
        const t = await loadTc(id);
        if (!t) return;
        const vars = { student: fullName(t.student), leavingDate: fmtDate(t.leavingDate), tcNo: t.tcNo ?? '' };
        if (what === 'requested') raiseLater('tc_requested', { office: () => holdersOf('tc.manage') }, vars, { dedupe: `tc:${id}:requested` });
        else raiseLater('tc_issued', { parent: () => parentsOf([t.studentId]) }, vars, { dedupe: `tc:${id}:issued` });
    })();
};
