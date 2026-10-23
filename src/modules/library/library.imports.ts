import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { registerImport } from '../imports/import.service';
import { KIND_LABEL, KINDS } from './library.settings';
import { addCopies } from './books.service';

/**
 * Excel import of the book list (Library → Books → Import). A row whose ISBN (or title + authors)
 * is already in the catalogue only adds its copies. Existing accession numbers can be given (a
 * library that already numbered its books); else new ones are made.
 */

interface Ctx {
    masters: Map<string, string>;
    byIsbn: Map<string, string>;
    byTitle: Map<string, string>;
    taken: Set<string>;
}

const key = (master: string, name: string) => `${master}|${name.trim().toLowerCase()}`;
const kindOf = (v: unknown) => {
    const t = String(v ?? '').trim().toLowerCase();
    if (!t) return 'book';
    return KINDS.find((k) => k === t || KIND_LABEL[k].toLowerCase() === t) ?? null;
};
const isbnOf = (v: unknown) => (v ? String(v).replace(/[^0-9Xx]/g, '').toUpperCase() || null : null);
const titleKey = (title: unknown, authors: unknown) => `${String(title ?? '').trim().toLowerCase()}|${String(authors ?? '').trim().toLowerCase()}`;
const accessions = (v: unknown) => String(v ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

registerImport<Ctx>({
    kind: 'library_books',
    label: 'Library books',
    permission: 'library.manage',
    columns: async () => {
        const m = await db.masterValue.findMany({ where: { master: { in: ['library_category', 'library_language', 'library_location'] }, isActive: true }, orderBy: { sortOrder: 'asc' }, select: { master: true, name: true } });
        const names = (master: string) => m.filter((x) => x.master === master).map((x) => x.name);
        return [
            { key: 'title', header: 'Title', type: 'text', required: true, max: 300, example: 'Wings of Fire' },
            { key: 'authors', header: 'Authors', type: 'text', max: 300, example: 'A. P. J. Abdul Kalam, Arun Tiwari' },
            { key: 'publisher', header: 'Publisher', type: 'text', max: 200, example: 'Universities Press' },
            { key: 'edition', header: 'Edition', type: 'text', max: 60 },
            { key: 'year', header: 'Year', type: 'number', example: '1999' },
            { key: 'isbn', header: 'ISBN', type: 'text', max: 20, example: '9788173711466' },
            { key: 'kind', header: 'Type', type: 'choice', choices: KINDS.map((k) => KIND_LABEL[k]), help: 'Empty = Book.', example: 'Book' },
            { key: 'category', header: 'Category', type: 'choice', choices: names('library_category'), example: 'Biography' },
            { key: 'language', header: 'Language', type: 'choice', choices: names('library_language'), example: 'English' },
            { key: 'location', header: 'Shelf', type: 'choice', choices: names('library_location'), example: 'Rack A1' },
            { key: 'callNumber', header: 'Call number', type: 'text', max: 40, example: '920 KAL' },
            { key: 'level', header: 'For (classes)', type: 'text', max: 60, example: 'Class VIII–XII' },
            { key: 'price', header: 'Price (₹)', type: 'number', example: '250' },
            { key: 'copies', header: 'Copies', type: 'number', help: 'How many copies (new accession numbers are made). Leave empty when you give the numbers.', example: '3' },
            { key: 'accessions', header: 'Accession numbers', type: 'text', max: 2000, help: 'Only if your books already have numbers: comma-separated, one per copy.', example: '' },
        ];
    },
    prepare: async () => {
        const [m, books, copies] = await Promise.all([
            db.masterValue.findMany({ where: { master: { in: ['library_category', 'library_language', 'library_location'] } }, select: { id: true, master: true, name: true } }),
            db.book.findMany({ select: { id: true, isbn: true, title: true, authors: true } }),
            db.bookCopy.findMany({ select: { accessionNo: true } }),
        ]);
        return {
            masters: new Map(m.map((x) => [key(x.master, x.name), x.id])),
            byIsbn: new Map(books.filter((b) => b.isbn).map((b) => [b.isbn!, b.id])),
            byTitle: new Map(books.map((b) => [titleKey(b.title, b.authors), b.id])),
            taken: new Set(copies.map((c) => c.accessionNo.toLowerCase())),
        };
    },
    check: (row, ctx) => {
        const v = row.values;
        if (!kindOf(v.kind)) row.issues.push({ field: 'Type', message: 'is not a type the library has' });
        const nums = accessions(v.accessions);
        const n = Number(v.copies ?? 0);
        if (!nums.length && (!Number.isInteger(n) || n < 0 || n > 200)) row.issues.push({ field: 'Copies', message: 'must be 0 to 200' });
        if (new Set(nums.map((x) => x.toLowerCase())).size !== nums.length) row.issues.push({ field: 'Accession numbers', message: 'has the same number twice' });
        for (const a of nums) if (ctx.taken.has(a.toLowerCase())) row.issues.push({ field: 'Accession numbers', message: `${a} is already used` });
        if (v.price !== undefined && v.price !== null && v.price !== '' && (Number(v.price) < 0 || !Number.isFinite(Number(v.price)))) row.issues.push({ field: 'Price (₹)', message: 'must be a number' });
    },
    importRow: async (row, ctx, userId) => {
        const v = row.values;
        const tenantId = getTenantId()!;
        const isbn = isbnOf(v.isbn);
        const m = (master: string, val: unknown) => (val ? (ctx.masters.get(key(master, String(val))) ?? null) : null);
        let bookId = (isbn && ctx.byIsbn.get(isbn)) || ctx.byTitle.get(titleKey(v.title, v.authors)) || null;
        const existed = !!bookId;
        if (!bookId) {
            const price = v.price ? Math.round(Number(v.price)) : null;
            const b = await db.book.create({ data: { tenantId, title: String(v.title).trim(), authors: v.authors ? String(v.authors).trim() : null, publisher: v.publisher ? String(v.publisher).trim() : null, edition: v.edition ? String(v.edition).trim() : null, year: v.year ? Math.round(Number(v.year)) : null, isbn, kind: kindOf(v.kind) ?? 'book', categoryId: m('library_category', v.category), languageId: m('library_language', v.language), locationId: m('library_location', v.location), callNumber: v.callNumber ? String(v.callNumber).trim() : null, level: v.level ? String(v.level).trim() : null, price, createdBy: userId } });
            bookId = b.id;
            if (isbn) ctx.byIsbn.set(isbn, b.id);
            ctx.byTitle.set(titleKey(v.title, v.authors), b.id);
        }
        const nums = accessions(v.accessions);
        let added = 0;
        if (nums.length) {
            const condition = await db.masterValue.findFirst({ where: { master: 'book_condition', name: 'Good' }, select: { id: true } });
            await db.bookCopy.createMany({ data: nums.map((accessionNo) => ({ tenantId, bookId: bookId!, accessionNo, conditionId: condition?.id ?? null, price: v.price ? Math.round(Number(v.price)) : null })) });
            nums.forEach((a) => ctx.taken.add(a.toLowerCase()));
            added = nums.length;
        } else if (Number(v.copies ?? 0) > 0) {
            added = (await addCopies(bookId, { count: Math.round(Number(v.copies)), source: 'purchase', price: v.price ? Math.round(Number(v.price)) : null }, userId)).added;
        }
        return { Title: String(v.title).trim(), Result: existed ? `Already there; ${added} cop${added === 1 ? 'y' : 'ies'} added` : `Added with ${added} cop${added === 1 ? 'y' : 'ies'}` };
    },
});
