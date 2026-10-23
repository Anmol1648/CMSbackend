import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { hashPassword } from '../../core/password';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { newAccessionNumbers } from './books.service';

/**
 * Demo library: ~200 titles (well-known books in English and Hindi, NCERT textbooks, reference,
 * magazines) with ~500 copies on racks; the demo librarian with a login; two months of lending
 * history; books out now (VII-B, Shubham Nautiyal with one overdue), fines (some in the fees), a
 * lost and a damaged book, and reservations. Marked is_demo.
 */

let seed = 4_211;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(l: readonly T[]) => l[Math.floor(rand() * l.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const DAY = 86_400_000;
const PASSWORD = 'Demo@2026';
const plus = (iso: string, n: number) => isoOf(new Date(dayDate(iso).getTime() + n * DAY));

// [title, authors, category, language, price, publisher, year, level]
type Row = [string, string, string, string, number, string, number, string?];
const BOOKS: Row[] = [
    ['Wings of Fire', 'A. P. J. Abdul Kalam, Arun Tiwari', 'Biography', 'English', 350, 'Universities Press', 1999, 'Class VIII–XII'],
    ['Ignited Minds', 'A. P. J. Abdul Kalam', 'Non-fiction', 'English', 250, 'Penguin', 2002, 'Class IX–XII'],
    ['Malgudi Days', 'R. K. Narayan', 'Fiction', 'English', 199, 'Indian Thought Publications', 1943, 'Class VI–XII'],
    ['Swami and Friends', 'R. K. Narayan', 'Fiction', 'English', 175, 'Indian Thought Publications', 1935, 'Class V–IX'],
    ['The Guide', 'R. K. Narayan', 'Fiction', 'English', 225, 'Indian Thought Publications', 1958, 'Class IX–XII'],
    ['The Room on the Roof', 'Ruskin Bond', 'Fiction', 'English', 199, 'Penguin', 1956, 'Class VII–XII'],
    ['The Blue Umbrella', 'Ruskin Bond', 'Children’s stories', 'English', 120, 'Rupa', 1980, 'Class III–VII'],
    ['Rusty, the Boy from the Hills', 'Ruskin Bond', 'Children’s stories', 'English', 150, 'Penguin', 2002, 'Class IV–VIII'],
    ['Our Trees Still Grow in Dehra', 'Ruskin Bond', 'Fiction', 'English', 199, 'Penguin', 1991, 'Class VII–XII'],
    ['Panchatantra Stories', 'Vishnu Sharma (retold)', 'Children’s stories', 'English', 150, 'Pustak Mahal', 2010, 'Class I–V'],
    ['Tales of Akbar and Birbal', 'Anant Pai (ed.)', 'Comics', 'English', 120, 'Amar Chitra Katha', 2008, 'Class II–VI'],
    ['Amar Chitra Katha: Shivaji', 'Anant Pai (ed.)', 'Comics', 'English', 80, 'Amar Chitra Katha', 2005, 'Class III–VIII'],
    ['Amar Chitra Katha: Rani of Jhansi', 'Anant Pai (ed.)', 'Comics', 'English', 80, 'Amar Chitra Katha', 2005, 'Class III–VIII'],
    ['Tinkle Digest 120', 'Tinkle', 'Comics', 'English', 90, 'Amar Chitra Katha', 2020, 'Class II–VII'],
    ['The Discovery of India', 'Jawaharlal Nehru', 'History', 'English', 450, 'Penguin', 1946, 'Class XI–XII'],
    ['Glimpses of World History', 'Jawaharlal Nehru', 'History', 'English', 550, 'Penguin', 1934, 'Class XI–XII'],
    ['My Experiments with Truth', 'M. K. Gandhi', 'Biography', 'English', 150, 'Navajivan', 1927, 'Class IX–XII'],
    ['India After Gandhi', 'Ramachandra Guha', 'History', 'English', 699, 'Picador', 2007, 'Class XII'],
    ['The Story of My Life', 'Helen Keller', 'Biography', 'English', 150, 'Fingerprint', 1903, 'Class VI–X'],
    ['The Diary of a Young Girl', 'Anne Frank', 'Biography', 'English', 199, 'Penguin', 1947, 'Class VIII–XII'],
    ['Alice’s Adventures in Wonderland', 'Lewis Carroll', 'Fiction', 'English', 150, 'Fingerprint', 1865, 'Class IV–VIII'],
    ['The Jungle Book', 'Rudyard Kipling', 'Fiction', 'English', 175, 'Fingerprint', 1894, 'Class III–VIII'],
    ['Treasure Island', 'Robert Louis Stevenson', 'Fiction', 'English', 175, 'Fingerprint', 1883, 'Class VI–X'],
    ['Robinson Crusoe', 'Daniel Defoe', 'Fiction', 'English', 199, 'Fingerprint', 1719, 'Class VII–XI'],
    ['Gulliver’s Travels', 'Jonathan Swift', 'Fiction', 'English', 199, 'Fingerprint', 1726, 'Class VII–XI'],
    ['Little Women', 'Louisa May Alcott', 'Fiction', 'English', 225, 'Fingerprint', 1868, 'Class VII–XI'],
    ['The Adventures of Tom Sawyer', 'Mark Twain', 'Fiction', 'English', 175, 'Fingerprint', 1876, 'Class VI–X'],
    ['Black Beauty', 'Anna Sewell', 'Fiction', 'English', 150, 'Fingerprint', 1877, 'Class IV–VIII'],
    ['Heidi', 'Johanna Spyri', 'Fiction', 'English', 150, 'Fingerprint', 1881, 'Class IV–VIII'],
    ['The Secret Garden', 'Frances Hodgson Burnett', 'Fiction', 'English', 175, 'Fingerprint', 1911, 'Class V–IX'],
    ['Charlie and the Chocolate Factory', 'Roald Dahl', 'Fiction', 'English', 299, 'Puffin', 1964, 'Class IV–VIII'],
    ['Matilda', 'Roald Dahl', 'Fiction', 'English', 299, 'Puffin', 1988, 'Class IV–VIII'],
    ['The BFG', 'Roald Dahl', 'Fiction', 'English', 299, 'Puffin', 1982, 'Class III–VII'],
    ['Harry Potter and the Philosopher’s Stone', 'J. K. Rowling', 'Fiction', 'English', 399, 'Bloomsbury', 1997, 'Class V–X'],
    ['Harry Potter and the Chamber of Secrets', 'J. K. Rowling', 'Fiction', 'English', 399, 'Bloomsbury', 1998, 'Class V–X'],
    ['The Little Prince', 'Antoine de Saint-Exupéry', 'Fiction', 'English', 150, 'Fingerprint', 1943, 'Class III–XII'],
    ['The Alchemist', 'Paulo Coelho', 'Fiction', 'English', 299, 'HarperCollins', 1988, 'Class IX–XII'],
    ['To Kill a Mockingbird', 'Harper Lee', 'Fiction', 'English', 399, 'Arrow', 1960, 'Class X–XII'],
    ['Animal Farm', 'George Orwell', 'Fiction', 'English', 150, 'Penguin', 1945, 'Class IX–XII'],
    ['Gitanjali', 'Rabindranath Tagore', 'Poetry', 'English', 150, 'Macmillan', 1910, 'Class IX–XII'],
    ['The Golden Gate of Poems', 'Various', 'Poetry', 'English', 175, 'Oxford', 2012, 'Class V–IX'],
    ['A Brief History of Time', 'Stephen Hawking', 'Science', 'English', 399, 'Bantam', 1988, 'Class XI–XII'],
    ['Surely You’re Joking, Mr. Feynman!', 'Richard Feynman', 'Science', 'English', 450, 'Vintage', 1985, 'Class XI–XII'],
    ['The Man Who Knew Infinity', 'Robert Kanigel', 'Biography', 'English', 499, 'Abacus', 1991, 'Class X–XII'],
    ['Mathematics for Fun', 'Shakuntala Devi', 'Mathematics', 'English', 199, 'Orient', 2005, 'Class V–IX'],
    ['Puzzles to Puzzle You', 'Shakuntala Devi', 'Mathematics', 'English', 150, 'Orient', 1976, 'Class VI–XII'],
    ['The Joy of x', 'Steven Strogatz', 'Mathematics', 'English', 450, 'Mariner', 2012, 'Class X–XII'],
    ['Lucent’s General Knowledge', 'Lucent', 'General knowledge', 'English', 275, 'Lucent', 2025, 'Class IX–XII'],
    ['Manorama Yearbook 2026', 'Malayala Manorama', 'General knowledge', 'English', 350, 'Malayala Manorama', 2026, 'Class VIII–XII'],
    ['Oxford Advanced Learner’s Dictionary', 'A. S. Hornby', 'Reference', 'English', 795, 'Oxford', 2020, 'All'],
    ['Oxford Student Atlas for India', 'Oxford', 'Geography', 'English', 395, 'Oxford', 2023, 'Class VI–XII'],
    ['Wren & Martin: High School English Grammar', 'P. C. Wren, H. Martin', 'Language & grammar', 'English', 450, 'S. Chand', 2018, 'Class VI–XII'],
    ['Word Power Made Easy', 'Norman Lewis', 'Language & grammar', 'English', 199, 'Penguin', 1949, 'Class IX–XII'],
    ['Computer Science with Python (Class XII)', 'Sumita Arora', 'Computer science', 'English', 650, 'Dhanpat Rai', 2024, 'Class XII'],
    ['Computer Science with Python (Class XI)', 'Sumita Arora', 'Computer science', 'English', 625, 'Dhanpat Rai', 2024, 'Class XI'],
    ['Concepts of Physics, Vol. 1', 'H. C. Verma', 'Science', 'English', 450, 'Bharati Bhawan', 2019, 'Class XI–XII'],
    ['Concepts of Physics, Vol. 2', 'H. C. Verma', 'Science', 'English', 450, 'Bharati Bhawan', 2019, 'Class XI–XII'],
    ['Objective Mathematics', 'R. D. Sharma', 'Competitive exams', 'English', 795, 'Dhanpat Rai', 2023, 'Class XI–XII'],
    ['Godaan', 'Munshi Premchand', 'Fiction', 'Hindi', 199, 'Rajkamal', 1936, 'Class IX–XII'],
    ['Nirmala', 'Munshi Premchand', 'Fiction', 'Hindi', 150, 'Rajkamal', 1927, 'Class IX–XII'],
    ['Idgah aur Anya Kahaniyan', 'Munshi Premchand', 'Children’s stories', 'Hindi', 120, 'Rajkamal', 1938, 'Class V–X'],
    ['Panch Parmeshwar', 'Munshi Premchand', 'Fiction', 'Hindi', 99, 'Rajkamal', 1916, 'Class VI–X'],
    ['Madhushala', 'Harivansh Rai Bachchan', 'Poetry', 'Hindi', 150, 'Rajpal', 1935, 'Class IX–XII'],
    ['Rashmirathi', 'Ramdhari Singh Dinkar', 'Poetry', 'Hindi', 150, 'Lokbharti', 1952, 'Class IX–XII'],
    ['Kamayani', 'Jaishankar Prasad', 'Poetry', 'Hindi', 175, 'Lokbharti', 1936, 'Class XI–XII'],
    ['Gunahon Ka Devta', 'Dharamvir Bharati', 'Fiction', 'Hindi', 225, 'Bharatiya Jnanpith', 1949, 'Class XI–XII'],
    ['Raag Darbari', 'Shrilal Shukla', 'Fiction', 'Hindi', 299, 'Rajkamal', 1968, 'Class XII'],
    ['Tamas', 'Bhisham Sahni', 'Fiction', 'Hindi', 250, 'Rajkamal', 1974, 'Class XII'],
    ['Agni Ki Udaan', 'A. P. J. Abdul Kalam', 'Biography', 'Hindi', 250, 'Prabhat', 2002, 'Class VIII–XII'],
    ['Satya Ke Prayog', 'M. K. Gandhi', 'Biography', 'Hindi', 120, 'Navajivan', 1927, 'Class IX–XII'],
    ['Panchatantra Ki Kahaniyan', 'Vishnu Sharma (retold)', 'Children’s stories', 'Hindi', 120, 'Pustak Mahal', 2011, 'Class I–V'],
    ['Chandamama Ki Kahaniyan', 'Various', 'Children’s stories', 'Hindi', 99, 'Chandamama', 2015, 'Class I–V'],
    ['Akbar Birbal Ke Kisse', 'Various', 'Children’s stories', 'Hindi', 99, 'Manoj', 2012, 'Class II–VI'],
    ['Hindi Vyakaran', 'Kamta Prasad Guru', 'Language & grammar', 'Hindi', 199, 'Lokbharti', 2015, 'Class VI–XII'],
    ['Sanskrit Vyakaran Pravesh', 'Various', 'Language & grammar', 'Sanskrit', 150, 'Chaukhamba', 2016, 'Class VI–X'],
    ['Hitopadesha', 'Narayana', 'Children’s stories', 'Sanskrit', 150, 'Chaukhamba', 2014, 'Class VI–X'],
    ['Bhagavad Gita (with Hindi meaning)', 'Gita Press', 'Religion & culture', 'Bilingual', 50, 'Gita Press', 2018, 'All'],
    ['Folk Tales of Uttarakhand', 'Various', 'Children’s stories', 'English', 199, 'Bishen Singh', 2017, 'Class IV–X'],
    ['Garhwali Lok Kathayen', 'Various', 'Children’s stories', 'Garhwali', 150, 'Samay Sakshya', 2019, 'Class IV–X'],
    ['The Himalayas: A Journey', 'Various', 'Geography', 'English', 499, 'Lonely Planet', 2016, 'Class VIII–XII'],
    ['Origami for Children', 'Various', 'Arts & crafts', 'English', 199, 'Usborne', 2014, 'Class I–VI'],
    ['Drawing and Sketching for Beginners', 'Various', 'Arts & crafts', 'English', 250, 'Om Books', 2018, 'Class III–X'],
    ['Rules of Cricket', 'MCC', 'Sports', 'English', 150, 'MCC', 2022, 'All'],
    ['Playing It My Way', 'Sachin Tendulkar', 'Sports', 'English', 499, 'Hodder', 2014, 'Class VIII–XII'],
    ['Mary Kom: Unbreakable', 'M. C. Mary Kom', 'Sports', 'English', 299, 'HarperCollins', 2013, 'Class VIII–XII'],
];
const SUBJECTS: [string, string, string][] = [
    ['English', 'English', 'Textbook'],
    ['Hindi', 'Hindi', 'Textbook'],
    ['Mathematics', 'English', 'Mathematics'],
    ['Science', 'English', 'Science'],
    ['Social Science', 'English', 'History'],
];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const MAGAZINES = ['Science Reporter (Oct 2026)', 'Champak (Oct 2026)', 'National Geographic Kids (Oct 2026)', 'Competition Success Review (Oct 2026)', 'Chakmak (Oct 2026)'];

export const createDemoLibrary = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.book.count({ where: { isDemo: true } }))) return { books: 0, copies: 0, loans: 0, out: 0, fines: 0, librarian: null as string | null };
    await seedMasters();
    if (!(await db.masterValue.findFirst({ where: { master: 'notification_type', code: 'library' } }))) await db.masterValue.create({ data: { tenantId, master: 'notification_type', name: 'Library', code: 'library', sortOrder: 99, extra: { icon: 'local_library' } } });
    if (!(await db.masterValue.findFirst({ where: { master: 'fee_head', code: 'LIB' } }))) await db.masterValue.create({ data: { tenantId, master: 'fee_head', name: 'Library fine', code: 'LIB', sortOrder: 99, extra: { one_time: false, refundable: false } } });
    const masters = await db.masterValue.findMany({ where: { master: { in: ['library_category', 'library_language', 'library_location', 'book_condition'] } }, select: { id: true, master: true, name: true } });
    const m = (master: string, name: string) => masters.find((x) => x.master === master && x.name === name)?.id ?? null;
    const racks = masters.filter((x) => x.master === 'library_location' && x.name.startsWith('Rack')).map((x) => x.id);

    // The librarian: the demo staff member with that designation, with a login and the Librarian role.
    let role = await db.role.findFirst({ where: { slug: 'librarian' } });
    role ??= await db.role.create({ data: { tenantId, slug: 'librarian', name: 'Librarian', description: 'Runs the library: books, the issue and return counter, fines.' } });
    const des = await db.masterValue.findFirst({ where: { master: 'designation', name: 'Librarian' }, select: { id: true } });
    const lib = des ? await db.staff.findFirst({ where: { isDemo: true, designationId: des.id }, select: { id: true, firstName: true, lastName: true, userId: true } }) : null;
    let librarian: string | null = null;
    if (lib) {
        let userId = lib.userId;
        if (!userId) {
            let username = `${lib.firstName}.${lib.lastName ?? ''}`.toLowerCase().replace(/[^a-z.]/g, '');
            for (let i = 2; await db.user.findFirst({ where: { username } }); i++) username = `${lib.firstName}.${lib.lastName ?? ''}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
            const u = await db.user.create({ data: { tenantId, kind: 'staff', username, displayName: [lib.firstName, lib.lastName].filter(Boolean).join(' '), passwordHash: await hashPassword(PASSWORD), mustChangePassword: false, isDemo: true } });
            await db.staff.update({ where: { id: lib.id }, data: { userId: u.id } });
            userId = u.id;
        }
        await db.userRole.createMany({ data: [{ tenantId, userId, roleId: role.id }], skipDuplicates: true });
        librarian = (await db.user.findFirst({ where: { id: userId }, select: { username: true } }))?.username ?? null;
    }
    const librarianUser = lib ? ((await db.staff.findFirst({ where: { id: lib.id }, select: { userId: true } }))?.userId ?? null) : null;

    // Titles: the list above, NCERT textbooks, reference and magazines.
    const today = todayIST();
    const titles: { title: string; authors: string; category: string; language: string; price: number; publisher: string; year: number; level?: string; kind: string; copies: number; added: number }[] = BOOKS.map(([title, authors, category, language, price, publisher, y, level]) => ({ title, authors, category, language, price, publisher, year: y, level, kind: category === 'Reference' ? 'reference' : 'book', copies: between(1, 4), added: between(30, 900) }));
    for (const r of ROMAN.slice(0, 10))
        for (const [subject, language, category] of SUBJECTS) {
            if (subject === 'Social Science' && ['I', 'II'].includes(r)) continue;
            titles.push({ title: `NCERT ${subject}: Class ${r}`, authors: 'NCERT', category, language, price: between(50, 180), publisher: 'NCERT', year: 2024, level: `Class ${r}`, kind: 'book', copies: between(2, 5), added: between(120, 400) });
        }
    for (const [subject, category] of [['Physics', 'Science'], ['Chemistry', 'Science'], ['Mathematics', 'Mathematics'], ['Biology', 'Science'], ['Accountancy', 'Textbook'], ['Economics', 'Textbook'], ['History', 'History'], ['Political Science', 'Textbook']] as const)
        for (const r of ['XI', 'XII']) titles.push({ title: `NCERT ${subject}: Class ${r}`, authors: 'NCERT', category, language: 'English', price: between(120, 300), publisher: 'NCERT', year: 2024, level: `Class ${r}`, kind: 'book', copies: between(2, 4), added: between(120, 400) });
    for (const t of MAGAZINES) titles.push({ title: t, authors: '', category: 'Magazines', language: t.startsWith('Chakmak') || t.startsWith('Champak') ? 'Hindi' : 'English', price: between(40, 120), publisher: '', year: 2026, kind: 'magazine', copies: 1, added: between(2, 20) });
    titles.push({ title: 'Encyclopaedia Britannica: Children’s Edition', authors: 'Britannica', category: 'Reference', language: 'English', price: 2500, publisher: 'Britannica', year: 2019, kind: 'reference', copies: 1, added: 800 });
    titles.push({ title: 'NCERT e-Pathshala: Science Class VII (e-book)', authors: 'NCERT', category: 'Science', language: 'English', price: 0, publisher: 'NCERT', year: 2024, kind: 'ebook', copies: 0, added: 60 });

    const copyRows: { id: string; bookId: string; title: string; price: number; kind: string }[] = [];
    const good = m('book_condition', 'Good');
    for (const t of titles) {
        const added = new Date(Date.now() - t.added * DAY);
        const b = await db.book.create({ data: { tenantId, title: t.title, authors: t.authors || null, publisher: t.publisher || null, year: t.year, kind: t.kind, categoryId: m('library_category', t.category), languageId: m('library_language', t.language), locationId: t.kind === 'reference' ? m('library_location', 'Reference section') : t.kind === 'magazine' ? m('library_location', 'Magazine stand') : t.level && /Class (I|II|III|IV|V)\b|I–V|II–V|III–V/.test(t.level) ? m('library_location', 'Junior corner') : pick(racks), level: t.level ?? null, price: t.price || null, link: t.kind === 'ebook' ? 'https://epathshala.nic.in' : null, createdAt: added, isDemo: true } });
        if (!t.copies) continue;
        const numbers = await newAccessionNumbers(t.copies);
        await db.bookCopy.createMany({ data: numbers.map((accessionNo) => ({ tenantId, bookId: b.id, accessionNo, status: 'available', conditionId: good, acquiredOn: dayDate(isoOf(added)), source: rand() < 0.15 ? 'donation' : 'purchase', price: t.price || null, isDemo: true })) });
        const made = await db.bookCopy.findMany({ where: { bookId: b.id }, select: { id: true } });
        for (const c of made) copyRows.push({ id: c.id, bookId: b.id, title: t.title, price: t.price, kind: t.kind });
    }

    // Members: students of the session (VII-B first) and a few teachers.
    const enrol = await db.enrolment.findMany({ where: { academicYearId: year.id, student: { status: 'active' } }, select: { studentId: true, section: { select: { name: true, schoolClass: { select: { name: true } } } } } });
    const viiB = enrol.filter((e) => e.section.name === 'B' && e.section.schoolClass.name === 'Class VII').map((e) => e.studentId);
    const others = enrol.filter((e) => !viiB.includes(e.studentId)).map((e) => e.studentId);
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const teachers = await db.staff.findMany({ where: { isDemo: true, userId: { not: null } }, select: { id: true, firstName: true, lastName: true }, take: 40 });
    const deepak = teachers.find((t) => t.firstName === 'Deepak' && t.lastName === 'Rautela');
    const lendable = copyRows.filter((c) => c.kind === 'book');
    const busy = new Set<string>();
    const free = () => {
        for (let i = 0; i < 50; i++) {
            const c = pick(lendable);
            if (!busy.has(c.id)) return c;
        }
        return lendable.find((c) => !busy.has(c.id))!;
    };
    let loans = 0;
    let fines = 0;
    const fine = async (r: { memberKind: string; studentId: string | null; staffId: string | null; loanId: string | null }, kind: string, amount: number, on: string, note: string, payAt: string, status = 'due') => {
        await db.libraryFine.create({ data: { tenantId, ...r, academicYearId: year.id, kind, amount, on: dayDate(on), note, payAt, status, ...(status === 'paid' ? { paidOn: dayDate(on), receiptNo: `LF/${on.slice(0, 4)}/${String(9000 + fines).padStart(4, '0')}` } : {}), isDemo: true, createdBy: librarianUser } });
        fines++;
    };

    // Two months of history (returned), a few late.
    for (let i = 0; i < 260; i++) {
        const sid = rand() < 0.35 ? pick(viiB) : pick(others);
        if (!sid) continue;
        const c = pick(lendable);
        const issued = plus(today, -between(15, 70));
        const due = plus(issued, 14);
        const late = rand() < 0.12 ? between(1, 9) : 0;
        const back = late ? plus(due, late) : plus(issued, between(3, 13));
        if (back >= today) continue;
        const l = await db.libraryLoan.create({ data: { tenantId, copyId: c.id, bookId: c.bookId, memberKind: 'student', studentId: sid, issuedOn: dayDate(issued), dueOn: dayDate(due), returnedOn: dayDate(back), status: 'returned', issuedBy: librarianUser, returnedBy: librarianUser, isDemo: true } });
        loans++;
        if (late) await fine({ memberKind: 'student', studentId: sid, staffId: null, loanId: l.id }, 'late', late * 2, back, `${c.title}: returned ${late} day${late === 1 ? '' : 's'} late`, 'fees');
    }

    // Out now: VII-B (one book each for most), some others, and teachers.
    const outNow = async (kind: 'student' | 'staff', id: string, issuedAgo: number, days: number) => {
        const c = free();
        busy.add(c.id);
        const issued = plus(today, -issuedAgo);
        await db.libraryLoan.create({ data: { tenantId, copyId: c.id, bookId: c.bookId, memberKind: kind, ...(kind === 'staff' ? { staffId: id } : { studentId: id }), issuedOn: dayDate(issued), dueOn: dayDate(plus(issued, days)), issuedBy: librarianUser, isDemo: true } });
        await db.bookCopy.update({ where: { id: c.id }, data: { status: 'issued' } });
        loans++;
        return c;
    };
    let out = 0;
    if (shubham) {
        await outNow('student', shubham.id, 11, 14); // due in 3 days
        await outNow('student', shubham.id, 20, 14); // 6 days overdue
        out += 2;
        await fine({ memberKind: 'student', studentId: shubham.id, staffId: null, loanId: null }, 'late', 8, plus(today, -25), 'Malgudi Days: returned 4 days late', 'fees');
    }
    for (const sid of viiB.filter((s) => s !== shubham?.id)) {
        if (rand() < 0.3) continue;
        await outNow('student', sid, between(1, 18), 14);
        out++;
    }
    for (let i = 0; i < 70; i++) {
        const sid = pick(others);
        if (!sid) continue;
        await outNow('student', sid, between(0, 20), rand() < 0.3 ? 7 : 14);
        out++;
    }
    for (const t of [...(deepak ? [deepak] : []), ...teachers.slice(0, 8)]) {
        await outNow('staff', t.id, between(2, 25), 30);
        out++;
    }

    // A lost book (charged, in the fees) and a damaged return; a staff counter fine.
    const lostSid = pick(viiB.filter((s) => s !== shubham?.id)) ?? pick(others);
    if (lostSid) {
        const c = free();
        busy.add(c.id);
        const l = await db.libraryLoan.create({ data: { tenantId, copyId: c.id, bookId: c.bookId, memberKind: 'student', studentId: lostSid, issuedOn: dayDate(plus(today, -40)), dueOn: dayDate(plus(today, -26)), returnedOn: dayDate(plus(today, -10)), status: 'lost', issuedBy: librarianUser, returnedBy: librarianUser, isDemo: true } });
        await db.bookCopy.update({ where: { id: c.id }, data: { status: 'lost' } });
        await fine({ memberKind: 'student', studentId: lostSid, staffId: null, loanId: l.id }, 'lost', c.price || 50, plus(today, -10), `${c.title} lost`, 'fees');
        loans++;
    }
    const dmg = free();
    busy.add(dmg.id);
    await db.bookCopy.update({ where: { id: dmg.id }, data: { status: 'damaged', conditionId: m('book_condition', 'Badly damaged'), notes: 'Pages torn, cover missing' } });
    if (teachers[3]) await fine({ memberKind: 'staff', studentId: null, staffId: teachers[3].id, loanId: null }, 'late', 30, plus(today, -6), 'Wings of Fire: returned 15 days late', 'counter');
    if (teachers[4]) await fine({ memberKind: 'staff', studentId: null, staffId: teachers[4].id, loanId: null }, 'late', 20, plus(today, -30), 'The Guide: returned 10 days late', 'counter', 'paid');

    // Reservations: a title whose copies are all out, with a queue; and one ready for a VII-B student.
    const allOut = await db.book.findFirst({ where: { isDemo: true, kind: 'book', copies: { some: {}, every: { status: 'issued' } } }, select: { id: true } });
    if (allOut) for (const sid of viiB.slice(2, 4)) await db.libraryReservation.create({ data: { tenantId, bookId: allOut.id, memberKind: 'student', studentId: sid, isDemo: true, createdBy: librarianUser } });
    const readyCopy = lendable.find((c) => !busy.has(c.id));
    if (readyCopy && viiB[5]) {
        busy.add(readyCopy.id);
        await db.libraryReservation.create({ data: { tenantId, bookId: readyCopy.bookId, memberKind: 'student', studentId: viiB[5], status: 'ready', copyId: readyCopy.id, readyAt: new Date(), holdUntil: dayDate(plus(today, 2)), isDemo: true, createdBy: librarianUser } });
        await db.bookCopy.update({ where: { id: readyCopy.id }, data: { status: 'on_hold' } });
    }

    return { books: titles.length, copies: copyRows.length, loans, out, fines, librarian };
};

export const clearDemoLibrary = async () => {
    const books = (await db.book.findMany({ where: { isDemo: true }, select: { id: true } })).map((b) => b.id);
    await db.libraryStockScan.deleteMany({ where: { check: { isDemo: true } } });
    await db.libraryStockCheck.deleteMany({ where: { isDemo: true } });
    await db.libraryFine.deleteMany({ where: { isDemo: true } });
    await db.libraryReservation.deleteMany({ where: { OR: [{ isDemo: true }, { bookId: { in: books } }] } });
    await db.libraryLoan.deleteMany({ where: { OR: [{ isDemo: true }, { bookId: { in: books } }] } });
    await db.book.deleteMany({ where: { isDemo: true } });
};
