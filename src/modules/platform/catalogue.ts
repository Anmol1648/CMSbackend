/**
 * The modules a school can be on (plans, Platform console). Each is a set of permission groups
 * (registerPermissions' module key): a school without a module loses those permissions, so its
 * menu items, pages, widgets, "waiting for you" cards, data sources and assistant look-ups go too.
 * The core of the ERP (students, staff, academic set-up, attendance, users, masters, settings,
 * dashboard, documents, reports) is always on.
 */

export interface ProductModule {
    key: string;
    label: string;
    description: string;
    /** Permission groups (registerPermissions module keys) that belong to it. */
    groups: string[];
}

export const PRODUCT_MODULES: ProductModule[] = [
    { key: 'admissions', label: 'Admissions', description: 'Enquiries, follow-ups, online admission form', groups: ['admissions'] },
    { key: 'fees', label: 'Fees', description: 'Fee structure, collection, receipts, dues, online payment', groups: ['fees'] },
    { key: 'exams', label: 'Exams & Results', description: 'Exams, marks, report cards, admit cards, seating', groups: ['exams'] },
    { key: 'homework', label: 'Homework', description: 'Homework and checking', groups: ['homework'] },
    { key: 'timetable', label: 'Timetable', description: 'Timetable, substitutions', groups: ['timetable'] },
    { key: 'leave', label: 'Staff Leave', description: 'Leave types, applications, approvals, balances', groups: ['leave'] },
    { key: 'notices', label: 'Notices & Events', description: 'Notices, circulars, calendar', groups: ['communication'] },
    { key: 'messaging', label: 'Messages & Alerts', description: 'Messages, email / SMS / WhatsApp alerts', groups: ['messaging'] },
    { key: 'learning', label: 'AI Learning & Tests', description: 'Question bank, online tests, AI tutor', groups: ['learn', 'tests', 'questions', 'ai'] },
    { key: 'assistant', label: 'AI Assistant', description: 'Ask questions about the school in plain words', groups: ['assistant'] },
    { key: 'transport', label: 'Transport', description: 'Routes, buses, live tracking', groups: ['transport'] },
    { key: 'library', label: 'Library', description: 'Books, issue and return, fines', groups: ['library'] },
    { key: 'ptm', label: 'Parent–Teacher Meetings', description: 'PTM slots and bookings', groups: ['ptm'] },
    { key: 'visitors', label: 'Visitors & Pickups', description: 'Gate register, passes, early pickups', groups: ['visitor'] },
    { key: 'complaints', label: 'Complaints', description: 'Tickets from parents and staff', groups: ['complaint'] },
    { key: 'discipline', label: 'Discipline', description: 'Incidents, actions, positive notes', groups: ['discipline'] },
    { key: 'cocurricular', label: 'Houses, Clubs & Competitions', description: 'House points, clubs, competitions, certificates, achievements', groups: ['cocurricular'] },
    { key: 'feedback', label: 'Teacher Feedback', description: 'Feedback rounds and results', groups: ['feedback'] },
    { key: 'files', label: 'Shared Files', description: 'Shared folders and files', groups: ['upload'] },
    { key: 'assets', label: 'Assets', description: 'Asset register, repairs, verification', groups: ['asset'] },
    { key: 'idcards', label: 'ID Cards', description: 'Card designs, printing, verification', groups: ['idcard'] },
    { key: 'inventory', label: 'Inventory', description: 'Store, purchase, issue, sales', groups: ['inventory'] },
    { key: 'payroll', label: 'Payroll', description: 'Salaries, payslips, PF / ESI / TDS, loans', groups: ['payroll'] },
    { key: 'accounts', label: 'Accounts', description: 'Vouchers, books, balance sheet, bank', groups: ['accounts'] },
    { key: 'hostel', label: 'Hostel', description: 'Rooms, roll call, leave passes, sick bay', groups: ['hostel'] },
    { key: 'mess', label: 'Mess', description: 'Plans, menu, headcount, counter', groups: ['mess'] },
];

export const moduleKeys = new Set(PRODUCT_MODULES.map((m) => m.key));

/** The permission groups a school does not have (none when it is on every module). */
export const disabledGroups = (t: { modulesAll: boolean; modules: string[] }) => {
    if (t.modulesAll) return new Set<string>();
    const on = new Set(t.modules);
    return new Set(PRODUCT_MODULES.filter((m) => !on.has(m.key)).flatMap((m) => m.groups));
};

/** Is a product module on for the school (for jobs and screens that aren't behind a permission). */
export const hasModule = (t: { modulesAll: boolean; modules: string[] }, key: string) => t.modulesAll || t.modules.includes(key);
