import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { schoolDays } from '../attendance/calendar.service';
import { defineAlert } from '../alerts/alerts.registry';
import { raiseLater } from '../alerts/deliver';
import { defineDailyJob } from '../alerts/jobs';
import { parentsOf, staffOf, studentsOf } from '../alerts/recipients';
import { LIBRARY } from './library.settings';
import { expireHolds, lateFine } from './circulation.service';

/** Library alerts (Alerts → Built-in Alerts) and the daily reminders. */

const recipients = [
    { key: 'member', label: 'The member (student or staff)' },
    { key: 'parent', label: 'Parents (of a student)' },
];
const who = [{ key: 'student', label: 'Member’s name', example: 'Shubham Nautiyal' }];

defineAlert({ key: 'library_due_soon', label: 'Library book due tomorrow', description: 'Daily: books due back the next school day.', type: 'library', when: 'daily', recipients, fields: [...who, { key: 'list', label: 'The books', example: '- Malgudi Days (LIB-00012)' }, { key: 'due', label: 'Due on', example: '25 Oct 2026' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['member', 'parent'], subject: 'Library book due {{due}}', body: 'Dear {{name}},\n\nPlease return (or renew) these library books of {{student}} by {{due}}:\n\n{{list}}', shortText: '{{school}}: library book of {{student}} due {{due}}.' }, link: '/my-library' });
defineAlert({ key: 'library_overdue', label: 'Library book overdue', description: 'Daily, every few days (System Settings → Library): books past their due date, with the fine so far.', type: 'library', when: 'daily', recipients, fields: [...who, { key: 'list', label: 'The books', example: '- Wings of Fire (LIB-00031), due 12 Oct, fine ₹14' }, { key: 'fine', label: 'Fine so far', example: '₹14' }], defaults: { enabled: true, channels: ['in_app', 'email'], recipients: ['member', 'parent'], priority: 'important', subject: 'Overdue library books ({{fine}} fine so far)', body: 'Dear {{name}},\n\nThese library books of {{student}} are overdue; the fine grows every day:\n\n{{list}}\n\nPlease return them to the library.', shortText: '{{school}}: overdue library book of {{student}}, fine {{fine}}.' }, link: '/my-library' });
defineAlert({ key: 'library_reserved_ready', label: 'Reserved book is ready', description: 'When a reserved book comes back and is kept for the member.', type: 'library', when: 'instant', recipients, fields: [...who, { key: 'title', label: 'Book', example: 'Wings of Fire' }, { key: 'until', label: 'Kept until', example: '28 Oct 2026' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['member', 'parent'], subject: '“{{title}}” is ready at the library', body: 'Dear {{name}},\n\n“{{title}}”, reserved for {{student}}, is ready at the library. It is kept until {{until}}.', shortText: '{{school}}: {{title}} is ready at the library till {{until}}.' }, link: '/my-library' });
defineAlert({ key: 'library_fine', label: 'Library fine', description: 'When a fine is charged (late, lost or damaged book).', type: 'library', when: 'instant', recipients, fields: [...who, { key: 'amount', label: 'Amount', example: '₹20' }, { key: 'reason', label: 'Why', example: 'Malgudi Days: returned 10 days late' }, { key: 'where', label: 'How to pay', example: 'It is added to the school fees (next instalment).' }], defaults: { enabled: true, channels: ['in_app'], recipients: ['member', 'parent'], subject: 'Library fine {{amount}}', body: 'Dear {{name}},\n\nA library fine of {{amount}} was charged to {{student}}: {{reason}}.\n\n{{where}}', shortText: '{{school}}: library fine {{amount}} for {{student}}.' }, link: '/my-library' });

const show = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
type Loan = { id: string; memberKind: string; studentId: string | null; staffId: string | null; dueOn: Date; copy: { accessionNo: string; book: { title: string } } };

/** Loans by member, with the member's name. */
const byMember = async (loans: Loan[]) => {
    const groups = new Map<string, Loan[]>();
    for (const l of loans) groups.set(`${l.memberKind}:${l.staffId ?? l.studentId}`, [...(groups.get(`${l.memberKind}:${l.staffId ?? l.studentId}`) ?? []), l]);
    const [students, staff] = await Promise.all([
        db.student.findMany({ where: { id: { in: loans.map((l) => l.studentId!).filter(Boolean) } }, select: { id: true, firstName: true, lastName: true } }),
        db.staff.findMany({ where: { id: { in: loans.map((l) => l.staffId!).filter(Boolean) } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const name = (l: Loan) => {
        const p = l.memberKind === 'staff' ? staff.find((s) => s.id === l.staffId) : students.find((s) => s.id === l.studentId);
        return p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : '';
    };
    return [...groups.values()].map((list) => ({ first: list[0], name: name(list[0]), list }));
};
const to = (l: Loan) => (l.memberKind === 'staff' ? { member: () => staffOf([l.staffId!]) } : { member: () => studentsOf([l.studentId!]), parent: () => parentsOf([l.studentId!]) });

defineDailyJob({
    key: 'library_due_soon',
    run: async () => {
        const today = todayIST();
        const next = (await schoolDays(isoOf(new Date(dayDate(today).getTime() + 86_400_000)), isoOf(new Date(dayDate(today).getTime() + 20 * 86_400_000)), 'students'))[0];
        if (!next) return '0 members';
        const loans = await db.libraryLoan.findMany({ where: { status: 'out', dueOn: dayDate(next) }, include: { copy: { select: { accessionNo: true, book: { select: { title: true } } } } } });
        const groups = await byMember(loans);
        for (const g of groups) raiseLater('library_due_soon', to(g.first), { student: g.name, due: show(next), list: g.list.map((l) => `- ${l.copy.book.title} (${l.copy.accessionNo})`).join('\n') }, { dedupe: `lib-due:${next}:${g.first.memberKind}:${g.first.staffId ?? g.first.studentId}` });
        return `${groups.length} members`;
    },
});

defineDailyJob({
    key: 'library_overdue',
    run: async () => {
        const today = todayIST();
        const { every } = await getSettings({ every: LIBRARY.overdueEvery });
        const loans = await db.libraryLoan.findMany({ where: { status: 'out', dueOn: { lt: dayDate(today) }, OR: [{ remindedOn: null }, { remindedOn: { lte: dayDate(isoOf(new Date(dayDate(today).getTime() - every * 86_400_000))) } }] }, include: { copy: { select: { accessionNo: true, book: { select: { title: true } } } } } });
        const groups = await byMember(loans);
        for (const g of groups) {
            let total = 0;
            const lines: string[] = [];
            for (const l of g.list) {
                const f = await lateFine(isoOf(l.dueOn), today);
                total += f.amount;
                lines.push(`- ${l.copy.book.title} (${l.copy.accessionNo}), due ${show(isoOf(l.dueOn))}${f.amount ? `, fine ₹${f.amount}` : ''}`);
            }
            raiseLater('library_overdue', to(g.first), { student: g.name, list: lines.join('\n'), fine: `₹${total}` }, { dedupe: `lib-overdue:${today}:${g.first.memberKind}:${g.first.staffId ?? g.first.studentId}` });
        }
        if (loans.length) await db.libraryLoan.updateMany({ where: { id: { in: loans.map((l) => l.id) } }, data: { remindedOn: dayDate(today) } });
        return `${groups.length} members`;
    },
});

defineDailyJob({
    key: 'library_holds',
    at: async () => '00:30',
    run: async () => `${await expireHolds()} holds ended`,
});
