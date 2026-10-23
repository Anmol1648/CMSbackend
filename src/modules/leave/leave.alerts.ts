import { db } from '../../core/db';
import { defineAlert } from '../alerts/alerts.registry';
import { raiseLater } from '../alerts/deliver';
import { holdersOf, staffOf, usersOf } from '../alerts/recipients';
import { fmtDate } from '../alerts/format';

/** Staff leave alerts: a request to decide, and the decision. */

const fields = [
    { key: 'staff', label: 'Staff member', example: 'Deepak Rautela' },
    { key: 'type', label: 'Leave type', example: 'Casual Leave' },
    { key: 'from', label: 'From', example: '28 Oct 2026' },
    { key: 'to', label: 'To', example: '29 Oct 2026' },
    { key: 'days', label: 'Days', example: '2' },
];

defineAlert({
    key: 'leave_applied',
    label: 'Leave to approve',
    description: 'When staff apply for leave (or it is recommended at the first level): to the person who decides it.',
    type: 'leave',
    when: 'instant',
    recipients: [{ key: 'approver', label: 'The approver' }],
    fields: [...fields, { key: 'reason', label: 'Reason', example: 'Family function' }],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['approver'],
        subject: 'Leave request: {{staff}}, {{days}} day(s)',
        body: 'Dear {{name}},\n\n{{staff}} has asked for {{type}} from {{from}} to {{to}} ({{days}} day(s)). Reason: {{reason}}.\n\nPlease approve or reject it under Leave → Approvals.',
        shortText: '{{school}}: {{staff}} asked for {{type}} {{from}}–{{to}}. Please decide in the app.',
    },
    link: '/leave/approvals',
});

defineAlert({
    key: 'leave_decided',
    label: 'Leave approved or rejected',
    description: 'When a leave request is approved or rejected: to the staff member.',
    type: 'leave',
    when: 'instant',
    recipients: [{ key: 'staff', label: 'The staff member' }],
    fields: [...fields, { key: 'decision', label: 'Approved / rejected', example: 'approved' }, { key: 'note', label: 'Note from the approver', example: '' }],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['staff'],
        subject: 'Your leave is {{decision}}',
        body: 'Dear {{name}},\n\nYour {{type}} from {{from}} to {{to}} ({{days}} day(s)) is {{decision}}. {{note}}',
        shortText: '{{school}}: your {{type}} {{from}}–{{to}} is {{decision}}.',
    },
    link: '/my-leave',
});

const loadLeave = (id: string) =>
    db.staffLeave.findFirst({ where: { id }, select: { id: true, stage: true, status: true, days: true, fromDate: true, toDate: true, reason: true, decisionNote: true, staff: { select: { id: true, firstName: true, middleName: true, lastName: true, reportsTo: { select: { userId: true, status: true } } } }, leaveType: { select: { name: true } } } });

const varsOf = (l: NonNullable<Awaited<ReturnType<typeof loadLeave>>>) => ({
    staff: [l.staff.firstName, l.staff.middleName, l.staff.lastName].filter(Boolean).join(' '),
    type: l.leaveType.name,
    from: fmtDate(l.fromDate),
    to: fmtDate(l.toDate),
    days: String(l.days),
    reason: l.reason ?? '',
});

/** A request waits for a decision: its manager at the first level, else those who approve everyone's leave. */
export const alertLeaveToDecide = (id: string) => {
    void (async () => {
        const l = await loadLeave(id);
        if (!l || l.status !== 'pending') return;
        const manager = l.stage === 1 && l.staff.reportsTo?.status === 'working' ? l.staff.reportsTo.userId : null;
        raiseLater('leave_applied', { approver: () => (manager ? usersOf([manager]) : holdersOf('leave.approve_all')) }, varsOf(l), { dedupe: `leave:${id}:stage${l.stage}` });
    })();
};

export const alertLeaveDecided = (id: string) => {
    void (async () => {
        const l = await loadLeave(id);
        if (!l || l.status === 'pending') return;
        raiseLater('leave_decided', { staff: () => staffOf([l.staff.id]) }, { ...varsOf(l), decision: l.status, note: l.decisionNote ?? '' }, { dedupe: `leave:${id}:${l.status}` });
    })();
};
