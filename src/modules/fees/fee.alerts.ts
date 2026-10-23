import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { defineAlert } from '../alerts/alerts.registry';
import { raise, raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { ALERTS } from '../alerts/alerts.settings';
import { parentsOf, sectionsOfStudents, studentsOf } from '../alerts/recipients';
import { addDays, fmtDate, rupees } from '../alerts/format';
import { todayIST } from '../attendance/attendance.settings';
import { fullName } from '../students/students.service';
import { computeDues, dueStudents } from './dues.service';

/** Fee alerts: payment received (with the receipt), instalment due soon, overdue reminders. */

const recipients = [
    { key: 'parent', label: 'Parents' },
    { key: 'student', label: 'The student' },
];

defineAlert({
    key: 'fee_payment_received',
    label: 'Fee payment received',
    description: 'When a fee receipt is made (at the counter or paid online); the receipt goes with the email.',
    type: 'fees',
    when: 'instant',
    recipients,
    fields: [
        { key: 'student', label: 'Student', example: 'Manish Rana' },
        { key: 'amount', label: 'Amount', example: '₹12,500' },
        { key: 'receiptNo', label: 'Receipt number', example: 'R/2026/0042' },
        { key: 'date', label: 'Date', example: '23 Oct 2026' },
        { key: 'mode', label: 'Paid by', example: 'UPI' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent'],
        required: true,
        subject: 'Fee received: {{amount}} for {{student}}',
        body: 'Dear {{name}},\n\nWe have received {{amount}} ({{mode}}) towards the fees of {{student}} on {{date}}. Receipt no. {{receiptNo}}.\n\nThe receipt is attached. Thank you.',
        shortText: '{{school}}: received {{amount}} for {{student}}, receipt {{receiptNo}}. Thank you.',
    },
    link: { parent: '/my-fees', student: '/my-fees' },
});

defineAlert({
    key: 'fee_due_soon',
    label: 'Fee instalment due soon',
    description: 'Daily: a reminder the number of days before an instalment is due (System Settings → Alerts), if it isn’t paid.',
    type: 'fees',
    when: 'daily',
    recipients,
    fields: [
        { key: 'student', label: 'Student', example: 'Manish Rana' },
        { key: 'instalment', label: 'Instalment', example: 'Quarter 3' },
        { key: 'dueDate', label: 'Due date', example: '26 Oct 2026' },
        { key: 'amount', label: 'Amount due', example: '₹8,400' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent'],
        subject: '{{instalment}} fees of {{student}} are due on {{dueDate}}',
        body: 'Dear {{name}},\n\nThis is a reminder that {{amount}} ({{instalment}}) for {{student}} is due on {{dueDate}}.\n\nYou can pay at the school office or online. Please ignore this if you have already paid.',
        shortText: '{{school}}: {{amount}} ({{instalment}}) for {{student}} is due on {{dueDate}}.',
    },
    link: { parent: '/my-fees', student: '/my-fees' },
});

defineAlert({
    key: 'fee_overdue',
    label: 'Fees overdue',
    description: 'A reminder every few days (System Settings → Alerts) while fees past their due date are unpaid.',
    type: 'fees',
    when: 'daily',
    recipients,
    fields: [
        { key: 'student', label: 'Student', example: 'Manish Rana' },
        { key: 'amount', label: 'Amount overdue', example: '₹8,400' },
        { key: 'instalments', label: 'Instalments', example: 'Quarter 2, Quarter 3' },
    ],
    defaults: {
        enabled: true,
        channels: ['in_app', 'email'],
        recipients: ['parent'],
        priority: 'important',
        subject: 'Fees overdue for {{student}}: {{amount}}',
        body: 'Dear {{name}},\n\nFees of {{amount}} for {{student}} ({{instalments}}) are past their due date. Late fine may apply.\n\nPlease pay at the school office or online at the earliest.',
        shortText: '{{school}}: {{amount}} overdue for {{student}} ({{instalments}}). Please pay soon.',
    },
    link: { parent: '/my-fees', student: '/my-fees' },
});

const MODES: Record<string, string> = { cash: 'cash', upi: 'UPI', online: 'online', cheque: 'cheque', dd: 'DD', card: 'card', neft: 'bank transfer' };

/** Called after a receipt is made; `byUserId` (the collector or payer) is who the attached receipt is drawn for. */
export const alertReceipt = (receiptId: string, byUserId: string | null) => {
    void (async () => {
        const r = await db.feeReceipt.findFirst({ where: { id: receiptId }, select: { id: true, receiptNo: true, amount: true, date: true, mode: true, studentId: true, student: { select: { firstName: true, middleName: true, lastName: true } } } });
        if (!r) return;
        raiseLater(
            'fee_payment_received',
            { parent: () => parentsOf([r.studentId]), student: () => studentsOf([r.studentId]) },
            { student: fullName(r.student), amount: rupees(r.amount), receiptNo: r.receiptNo, date: fmtDate(r.date), mode: MODES[r.mode] ?? r.mode },
            { dedupe: `receipt:${r.id}`, sectionIds: await sectionsOfStudents([r.studentId]), documents: byUserId ? () => [{ key: 'fee_receipt', params: { id: r.id }, asUserId: byUserId }] : null }
        );
    })();
};

const studentNames = async (ids: string[]) => new Map((await db.student.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, middleName: true, lastName: true } })).map((s) => [s.id, fullName(s)]));

defineDailyJob({
    key: 'fee_due_soon',
    run: async () => {
        const year = await currentYear();
        if (!year) return 'no session';
        const { days } = await getSettings({ days: ALERTS.feeDueDays });
        const target = addDays(todayIST(), days);
        if (!(await db.feeInstalment.count({ where: { academicYearId: year.id, dueDate: new Date(`${target}T00:00:00Z`) } }))) return 'no instalment due then';
        const students = await dueStudents(year.id, { status: 'active' });
        const dues = await computeDues(year.id, students);
        const hits = [...dues.values()].flatMap((d) => d.instalments.filter((i) => i.dueDate === target && i.balance > 0).map((i) => ({ studentId: d.studentId, i })));
        const names = await studentNames(hits.map((h) => h.studentId));
        const sectionOf = new Map(students.map((s) => [s.id, s.sectionId]));
        for (const h of hits)
            await raise(
                'fee_due_soon',
                { parent: () => parentsOf([h.studentId]), student: () => studentsOf([h.studentId]) },
                { student: names.get(h.studentId) ?? '', instalment: h.i.name, dueDate: fmtDate(h.i.dueDate), amount: rupees(h.i.balance) },
                { dedupe: `due:${h.studentId}:${h.i.id}`, sectionIds: [sectionOf.get(h.studentId)!].filter(Boolean) }
            );
        return `${hits.length} students`;
    },
});

defineDailyJob({
    key: 'fee_overdue',
    run: async () => {
        const year = await currentYear();
        if (!year) return 'no session';
        const { every } = await getSettings({ every: ALERTS.overdueEvery });
        // Once every N days: the reminder's "round" is part of its key.
        const round = Math.floor(Date.parse(`${todayIST()}T00:00:00Z`) / 86_400_000 / every);
        const students = await dueStudents(year.id, { status: 'active' });
        const dues = await computeDues(year.id, students);
        const hits = [...dues.values()].filter((d) => d.totals.overdue > 0);
        const names = await studentNames(hits.map((h) => h.studentId));
        const sectionOf = new Map(students.map((s) => [s.id, s.sectionId]));
        for (const d of hits)
            await raise(
                'fee_overdue',
                { parent: () => parentsOf([d.studentId]), student: () => studentsOf([d.studentId]) },
                { student: names.get(d.studentId) ?? '', amount: rupees(d.totals.overdue), instalments: d.instalments.filter((i) => i.overdue && i.balance > 0).map((i) => i.name).join(', ') },
                { dedupe: `overdue:${d.studentId}:${round}`, sectionIds: [sectionOf.get(d.studentId)!].filter(Boolean) }
            );
        return `${hits.length} students`;
    },
});
