import { db } from '../../core/db';
import { defineAlert } from '../alerts/alerts.registry';
import { raise, raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { staffOf } from '../alerts/recipients';
import { todayIST } from '../attendance/attendance.settings';

/** Admission alerts: an enquiry given to someone, and the day's follow-ups. */

defineAlert({
    key: 'enquiry_assigned',
    label: 'Enquiry assigned',
    description: 'When an admission enquiry is given to a staff member to follow up.',
    type: 'admissions',
    when: 'instant',
    recipients: [{ key: 'staff', label: 'The staff member' }],
    fields: [
        { key: 'enquiryNo', label: 'Enquiry number', example: 'ENQ/2026/0118' },
        { key: 'student', label: 'Child', example: 'Aarav' },
        { key: 'parent', label: 'Parent', example: 'Rakesh Negi' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['staff'],
        subject: 'New enquiry for you: {{student}} ({{enquiryNo}})',
        body: 'Dear {{name}},\n\nThe admission enquiry {{enquiryNo}} for {{student}} (parent {{parent}}) is now with you to follow up.',
        shortText: '{{school}}: enquiry {{enquiryNo}} ({{student}}) is with you to follow up.',
    },
    link: '/admissions',
});

defineAlert({
    key: 'enquiry_followups_due',
    label: 'Follow-ups due today',
    description: 'Daily: to each staff member, their enquiries due for a follow-up today (or overdue).',
    type: 'admissions',
    when: 'daily',
    recipients: [{ key: 'staff', label: 'The staff member' }],
    fields: [
        { key: 'count', label: 'How many', example: '3' },
        { key: 'list', label: 'The enquiries', example: 'Aarav (ENQ/2026/0118), Diya (ENQ/2026/0121)' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app'],
        recipients: ['staff'],
        subject: '{{count}} enquiries to follow up today',
        body: 'Dear {{name}},\n\nThese enquiries are due for a follow-up: {{list}}.',
        shortText: '{{school}}: {{count}} enquiries to follow up today.',
    },
    link: '/admissions',
});

/** Called when an enquiry is created or changed; alerts the new person it is with (not the one who did it). */
export const alertEnquiryAssigned = (enquiryId: string, byUserId: string) => {
    void (async () => {
        const e = await db.enquiry.findFirst({ where: { id: enquiryId }, select: { id: true, enquiryNo: true, studentFirstName: true, parentName: true, assignedToId: true, assignedTo: { select: { userId: true } } } });
        if (!e?.assignedToId || e.assignedTo?.userId === byUserId) return;
        raiseLater('enquiry_assigned', { staff: () => staffOf([e.assignedToId!]) }, { enquiryNo: e.enquiryNo, student: e.studentFirstName, parent: e.parentName ?? '' }, { dedupe: `enquiry:${e.id}:${e.assignedToId}` });
    })();
};

defineDailyJob({
    key: 'enquiry_followups_due',
    run: async () => {
        const today = todayIST();
        const lost = await db.masterValue.findMany({ where: { master: 'enquiry_stage', OR: [{ code: { in: ['lost', 'admitted'] } }, { name: { in: ['Lost', 'Admitted'] } }] }, select: { id: true } });
        const due = await db.enquiry.findMany({
            where: { nextFollowUp: { lte: new Date(`${today}T00:00:00Z`) }, assignedToId: { not: null }, stageId: { notIn: lost.map((l) => l.id) } },
            select: { enquiryNo: true, studentFirstName: true, assignedToId: true },
            orderBy: { nextFollowUp: 'asc' },
        });
        const byStaff = new Map<string, string[]>();
        for (const e of due) byStaff.set(e.assignedToId!, [...(byStaff.get(e.assignedToId!) ?? []), `${e.studentFirstName} (${e.enquiryNo})`]);
        for (const [staffId, list] of byStaff) await raise('enquiry_followups_due', { staff: () => staffOf([staffId]) }, { count: String(list.length), list: list.slice(0, 20).join(', ') + (list.length > 20 ? ` and ${list.length - 20} more` : '') }, { dedupe: `followups:${staffId}:${today}` });
        return `${byStaff.size} staff`;
    },
});
