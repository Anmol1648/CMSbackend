import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { defineReport, registerReportCategory } from '../reports/reports.registry';
import { defineDefaultLayout, defineWidget } from '../dashboard/dashboard.registry';
import { KIND_LABEL, LIBRARY } from './library.settings';
import { lateFine } from './circulation.service';
import { memberNames } from './members.service';
import { counterSummary, myLibrary } from './library.service';

/** Library reports (Report Center) and dashboard widgets. */

registerReportCategory('Library', 44);

const VIEW = ['library.view', 'library.issue', 'library.manage'];
const period = (f: Record<string, string>) => {
    if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
    return { gte: dayDate(f.from), lte: dayDate(f.to) };
};
const range = [
    { key: 'from', label: 'From', type: 'date' as const, required: true, default: 'monthStart' },
    { key: 'to', label: 'To', type: 'date' as const, required: true, default: 'today' },
];

defineReport({
    key: 'library_issued',
    category: 'Library',
    label: 'Books issued and returned',
    description: 'Every book lent in a period: to whom, when it was due and when it came back.',
    permissions: VIEW,
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'issuedOn', label: 'Issued', type: 'date', width: 0.8 },
        { key: 'accessionNo', label: 'Acc. no.', type: 'text', width: 0.8 },
        { key: 'title', label: 'Book', type: 'text', width: 2 },
        { key: 'member', label: 'Member', type: 'text', width: 1.8 },
        { key: 'dueOn', label: 'Due', type: 'date', width: 0.8 },
        { key: 'returnedOn', label: 'Returned', type: 'date', width: 0.8 },
        { key: 'state', label: 'State', type: 'text', width: 0.8 },
    ],
    async run(f) {
        const loans = await db.libraryLoan.findMany({ where: { issuedOn: period(f) }, orderBy: { issuedOn: 'asc' }, include: { copy: { select: { accessionNo: true, book: { select: { title: true } } } } } });
        const names = await memberNames(loans);
        const today = todayIST();
        return { subtitle: `${f.from} – ${f.to}`, rows: loans.map((l) => ({ issuedOn: isoOf(l.issuedOn), accessionNo: l.copy.accessionNo, title: l.copy.book.title, member: names.get(l.studentId ?? l.staffId ?? '') ?? '', dueOn: isoOf(l.dueOn), returnedOn: l.returnedOn ? isoOf(l.returnedOn) : null, state: l.status === 'lost' ? 'Lost' : l.status === 'returned' ? (l.returnedOn && l.returnedOn > l.dueOn ? 'Returned late' : 'Returned') : isoOf(l.dueOn) < today ? 'Overdue' : 'Out' })) };
    },
});

defineReport({
    key: 'library_overdue',
    category: 'Library',
    label: 'Overdue books',
    description: 'Books past their due date today, with the member, their class and the fine so far.',
    permissions: VIEW,
    orientation: 'landscape',
    about: 'student',
    filters: [{ key: 'who', label: 'Members', type: 'select', default: '', options: [{ value: '', label: 'Everyone' }, { value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }] }],
    columns: [
        { key: 'member', label: 'Member', type: 'text', width: 1.8 },
        { key: 'title', label: 'Book', type: 'text', width: 2 },
        { key: 'accessionNo', label: 'Acc. no.', type: 'text', width: 0.8 },
        { key: 'dueOn', label: 'Due', type: 'date', width: 0.8 },
        { key: 'days', label: 'Days late', type: 'number', width: 0.6 },
        { key: 'fine', label: 'Fine so far', type: 'money', width: 0.8, total: true },
    ],
    async run(f) {
        const today = todayIST();
        const loans = await db.libraryLoan.findMany({ where: { status: 'out', dueOn: { lt: dayDate(today) }, ...(f.who ? { memberKind: f.who } : {}) }, orderBy: { dueOn: 'asc' }, include: { copy: { select: { accessionNo: true, book: { select: { title: true } } } } } });
        const names = await memberNames(loans);
        const rows = [];
        for (const l of loans) {
            const fine = await lateFine(isoOf(l.dueOn), today);
            rows.push({ studentId: l.studentId ?? undefined, member: names.get(l.studentId ?? l.staffId ?? '') ?? '', title: l.copy.book.title, accessionNo: l.copy.accessionNo, dueOn: isoOf(l.dueOn), days: Math.round((dayDate(today).getTime() - l.dueOn.getTime()) / 86_400_000), fine: fine.amount });
        }
        return { subtitle: `As on ${today}`, rows };
    },
});

defineReport({
    key: 'library_fines',
    category: 'Library',
    label: 'Library fines',
    description: 'Fines charged in a period (late, lost, damaged): how much, waived, and where they are paid.',
    permissions: ['library.view', 'library.fines', 'fee.reports'],
    orientation: 'landscape',
    filters: range,
    columns: [
        { key: 'on', label: 'Date', type: 'date', width: 0.8 },
        { key: 'member', label: 'Member', type: 'text', width: 1.7 },
        { key: 'kind', label: 'For', type: 'text', width: 0.7 },
        { key: 'note', label: 'Details', type: 'text', width: 2 },
        { key: 'amount', label: 'Fine', type: 'money', width: 0.7, total: true },
        { key: 'waived', label: 'Waived', type: 'money', width: 0.7, total: true },
        { key: 'net', label: 'To pay', type: 'money', width: 0.7, total: true },
        { key: 'payAt', label: 'Paid', type: 'text', width: 0.9 },
    ],
    async run(f) {
        const fines = await db.libraryFine.findMany({ where: { on: period(f) }, orderBy: { on: 'asc' } });
        const names = await memberNames(fines);
        const KIND: Record<string, string> = { late: 'Late', lost: 'Lost', damaged: 'Damaged' };
        return { subtitle: `${f.from} – ${f.to}`, rows: fines.map((x) => ({ on: isoOf(x.on), member: names.get(x.studentId ?? x.staffId ?? '') ?? '', kind: KIND[x.kind] ?? x.kind, note: x.note ?? '', amount: x.amount, waived: x.waived, net: x.amount - x.waived, payAt: x.payAt === 'fees' ? 'With the fees' : x.status === 'paid' ? `Library (${x.receiptNo})` : x.status === 'waived' ? 'Waived' : 'Library: due' })) };
    },
});

defineReport({
    key: 'library_popular',
    category: 'Library',
    label: 'Most-read books',
    description: 'The titles lent most in a period, and how many members read them.',
    permissions: VIEW,
    orientation: 'portrait',
    filters: [...range, { key: 'top', label: 'Show', type: 'select', default: '25', options: [{ value: '10', label: 'Top 10' }, { value: '25', label: 'Top 25' }, { value: '100', label: 'Top 100' }] }],
    columns: [
        { key: 'rank', label: '#', type: 'number', width: 0.4 },
        { key: 'title', label: 'Book', type: 'text', width: 2.2 },
        { key: 'authors', label: 'Authors', type: 'text', width: 1.4 },
        { key: 'times', label: 'Times lent', type: 'number', width: 0.7, total: true },
        { key: 'readers', label: 'Readers', type: 'number', width: 0.7 },
    ],
    async run(f) {
        const groups = await db.libraryLoan.groupBy({ by: ['bookId'], where: { issuedOn: period(f) }, _count: { _all: true }, orderBy: { _count: { bookId: 'desc' } }, take: Number(f.top) || 25 });
        const [books, readers] = await Promise.all([db.book.findMany({ where: { id: { in: groups.map((g) => g.bookId) } }, select: { id: true, title: true, authors: true } }), db.libraryLoan.findMany({ where: { issuedOn: period(f), bookId: { in: groups.map((g) => g.bookId) } }, select: { bookId: true, studentId: true, staffId: true }, distinct: ['bookId', 'studentId', 'staffId'] })]);
        return { subtitle: `${f.from} – ${f.to}`, rows: groups.map((g, i) => ({ rank: i + 1, title: books.find((b) => b.id === g.bookId)?.title ?? '', authors: books.find((b) => b.id === g.bookId)?.authors ?? '', times: g._count._all, readers: readers.filter((r) => r.bookId === g.bookId).length })) };
    },
});

defineReport({
    key: 'library_readers',
    category: 'Library',
    label: 'Most active readers',
    description: 'Students (and staff) who read the most books in a period.',
    permissions: VIEW,
    orientation: 'portrait',
    about: 'student',
    filters: [...range, { key: 'who', label: 'Members', type: 'select', default: 'student', options: [{ value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }] }],
    columns: [
        { key: 'rank', label: '#', type: 'number', width: 0.4 },
        { key: 'member', label: 'Member', type: 'text', width: 2.2 },
        { key: 'books', label: 'Books read', type: 'number', width: 0.8, total: true },
    ],
    async run(f) {
        const kind = f.who === 'staff' ? 'staff' : 'student';
        const groups = await db.libraryLoan.groupBy({ by: kind === 'staff' ? ['staffId'] : ['studentId'], where: { issuedOn: period(f), memberKind: kind }, _count: { _all: true } });
        const sorted = groups.sort((a, b) => b._count._all - a._count._all).slice(0, 50);
        const names = await memberNames(sorted.map((g) => ({ memberKind: kind, studentId: (g as { studentId?: string | null }).studentId ?? null, staffId: (g as { staffId?: string | null }).staffId ?? null })));
        return { subtitle: `${f.from} – ${f.to}`, rows: sorted.map((g, i) => { const id = (g as { studentId?: string | null; staffId?: string | null }).studentId ?? (g as { staffId?: string | null }).staffId ?? ''; return { rank: i + 1, studentId: kind === 'student' ? id : undefined, member: names.get(id) ?? '', books: g._count._all }; }) };
    },
});

defineReport({
    key: 'library_stock',
    category: 'Library',
    label: 'Library stock',
    description: 'Titles and copies by category: on the shelf, lent, lost, damaged and withdrawn, and their value.',
    permissions: VIEW,
    orientation: 'landscape',
    filters: [],
    columns: [
        { key: 'category', label: 'Category', type: 'text', width: 1.6 },
        { key: 'titles', label: 'Titles', type: 'number', width: 0.6, total: true },
        { key: 'copies', label: 'Copies', type: 'number', width: 0.6, total: true },
        { key: 'available', label: 'On shelf', type: 'number', width: 0.6, total: true },
        { key: 'issued', label: 'Lent', type: 'number', width: 0.6, total: true },
        { key: 'lost', label: 'Lost', type: 'number', width: 0.6, total: true },
        { key: 'damaged', label: 'Damaged', type: 'number', width: 0.6, total: true },
        { key: 'withdrawn', label: 'Withdrawn', type: 'number', width: 0.7, total: true },
        { key: 'value', label: 'Value', type: 'money', width: 0.8, total: true },
    ],
    async run() {
        const [books, copies, cats] = await Promise.all([db.book.findMany({ select: { id: true, categoryId: true, price: true } }), db.bookCopy.findMany({ select: { bookId: true, status: true, price: true } }), db.masterValue.findMany({ where: { master: 'library_category' }, select: { id: true, name: true } })]);
        const cat = new Map(books.map((b) => [b.id, b.categoryId]));
        const price = new Map(books.map((b) => [b.id, b.price ?? 0]));
        const by = new Map<string, { category: string; titles: number; copies: number; available: number; issued: number; lost: number; damaged: number; withdrawn: number; value: number }>();
        const get = (id: string | null) => {
            const k = id ?? 'none';
            if (!by.has(k)) by.set(k, { category: cats.find((c) => c.id === id)?.name ?? 'No category', titles: 0, copies: 0, available: 0, issued: 0, lost: 0, damaged: 0, withdrawn: 0, value: 0 });
            return by.get(k)!;
        };
        for (const b of books) get(b.categoryId).titles++;
        for (const c of copies) {
            const g = get(cat.get(c.bookId) ?? null);
            g.copies++;
            if (c.status === 'available' || c.status === 'on_hold') g.available++;
            else if (c.status === 'issued') g.issued++;
            else if (c.status === 'lost') g.lost++;
            else if (c.status === 'damaged') g.damaged++;
            else if (c.status === 'withdrawn') g.withdrawn++;
            if (!['lost', 'withdrawn'].includes(c.status)) g.value += c.price ?? price.get(c.bookId) ?? 0;
        }
        return { rows: [...by.values()].sort((a, b) => a.category.localeCompare(b.category)) };
    },
});

defineReport({
    key: 'library_never_issued',
    category: 'Library',
    label: 'Books never lent',
    description: 'Titles (and copies) not lent since a date: to move, promote or withdraw.',
    permissions: VIEW,
    orientation: 'landscape',
    filters: [{ key: 'since', label: 'Not lent since', type: 'date', required: true, default: 'yearStart' }],
    columns: [
        { key: 'title', label: 'Book', type: 'text', width: 2.2 },
        { key: 'authors', label: 'Authors', type: 'text', width: 1.4 },
        { key: 'kind', label: 'Type', type: 'text', width: 0.7 },
        { key: 'copies', label: 'Copies', type: 'number', width: 0.6, total: true },
        { key: 'added', label: 'Added', type: 'date', width: 0.8 },
    ],
    async run(f) {
        const lent = new Set((await db.libraryLoan.findMany({ where: { issuedOn: { gte: dayDate(f.since) } }, select: { bookId: true }, distinct: ['bookId'] })).map((l) => l.bookId));
        const books = await db.book.findMany({ where: { isActive: true, kind: { not: 'ebook' } }, orderBy: { title: 'asc' }, select: { id: true, title: true, authors: true, kind: true, createdAt: true, _count: { select: { copies: true } } } });
        return { subtitle: `Since ${f.since}`, rows: books.filter((b) => !lent.has(b.id) && b._count.copies).map((b) => ({ title: b.title, authors: b.authors ?? '', kind: KIND_LABEL[b.kind as keyof typeof KIND_LABEL] ?? b.kind, copies: b._count.copies, added: isoOf(b.createdAt) })) };
    },
});

// ─── Widgets ─────────────────────────────────────────────────────────────────

defineWidget({
    key: 'library_today',
    label: 'Library today',
    description: 'Books out, overdue and due today; issued and returned today; reserved books waiting.',
    category: 'Today',
    type: 'stat',
    size: 'sm',
    href: '/library',
    permissions: ['library.issue', 'library.view'],
    cacheSeconds: 60,
    async load() {
        const s = await counterSummary();
        return { value: s.out, caption: 'books out', tone: s.overdue ? 'warn' : 'neutral', sub: [{ label: 'Overdue', value: s.overdue, tone: s.overdue ? 'bad' : undefined }, { label: 'Due today', value: s.dueToday }, { label: 'Issued / returned today', value: `${s.issuedToday} / ${s.returnedToday}` }, { label: 'Reserved, waiting', value: s.ready }] };
    },
});

defineWidget({
    key: 'library_new',
    label: 'New in the library',
    description: 'Titles added lately.',
    category: 'Library',
    type: 'list',
    size: 'md',
    href: '/my-library',
    permissions: ['library.mine', 'library.view'],
    cacheSeconds: 600,
    async load() {
        const { days } = await getSettings({ days: LIBRARY.newArrivalsDays });
        const rows = await db.book.findMany({ where: { isActive: true, createdAt: { gte: new Date(Date.now() - days * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 6, select: { title: true, authors: true } });
        return { items: rows.map((b) => ({ title: b.title, sub: b.authors ?? undefined })), empty: 'No new books lately.' };
    },
});

defineWidget({
    key: 'my_library_books',
    label: 'My library books',
    description: 'Library books a student (or each child, or a staff member) has, and when they are due.',
    category: 'Library',
    type: 'list',
    size: 'md',
    href: '/my-library',
    permissions: ['library.mine'],
    cacheSeconds: 120,
    async load({ userId }) {
        const mine = await myLibrary(userId);
        const items = mine.members.flatMap((m) => m.loans.map((l) => ({ title: l.title, sub: `${mine.members.length > 1 ? `${m.member.name} · ` : ''}due ${l.dueOn}${l.fineSoFar ? ` · fine ₹${l.fineSoFar}` : ''}`, tone: (l.overdue ? 'bad' : 'neutral') as 'bad' | 'neutral', href: '/my-library' })));
        if (!mine.members.length) return { hidden: true, items: [], empty: '' };
        return { items: items.slice(0, 8), empty: 'No library books right now.' };
    },
});

defineDefaultLayout('librarian', ['library_today', 'my_checkin', 'library_new', 'approvals', 'my_leave', 'notices_latest', 'upcoming_events']);
