import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, conflict, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';
import { KINDS, LIBRARY } from './library.settings';
import { memberNames } from './members.service';

/**
 * The catalogue: titles (books, magazines, reference, e-books) and their physical copies, each
 * with an accession number (its barcode). Copies are lent; a title is what members search and
 * reserve.
 */

const opt = (max: number) => z.string().trim().max(max).nullable().optional();

export const bookSchema = z.strictObject({
    title: z.string().trim().min(1, 'is required').max(300),
    subtitle: opt(300),
    authors: opt(300),
    publisher: opt(200),
    edition: opt(60),
    year: z.number().int().min(1500).max(2100).nullable().optional(),
    isbn: z.string().trim().max(20).regex(/^[0-9Xx-]*$/, 'only digits, X and dashes').nullable().optional(),
    kind: z.enum(KINDS).default('book'),
    categoryId: z.uuid().nullable().optional(),
    languageId: z.uuid().nullable().optional(),
    locationId: z.uuid().nullable().optional(),
    callNumber: opt(40),
    level: opt(60),
    price: z.number().int().min(0).max(1_000_000).nullable().optional(),
    pages: z.number().int().min(1).max(100_000).nullable().optional(),
    keywords: opt(300),
    coverFileId: z.uuid().nullable().optional(),
    fileId: z.uuid().nullable().optional(),
    link: z.string().trim().max(500).refine((u) => !u || /^https?:\/\//.test(u), 'must start with https://').nullable().optional(),
    notes: opt(1000),
    isActive: z.boolean().default(true),
    /** New title: how many copies to add with it. */
    copies: z.number().int().min(0).max(200).optional(),
});

export const booksQuery = z.object({
    search: z.string().trim().max(100).optional(),
    category: z.uuid().optional(),
    kind: z.enum(KINDS).optional(),
    show: z.enum(['all', 'available', 'out', 'new', 'inactive']).default('all'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

const normIsbn = (s: string | null | undefined) => (s ? s.replace(/[^0-9Xx]/g, '').toUpperCase() : null);

/** Gives `count` new accession numbers (LIB-00123…). */
export const newAccessionNumbers = async (count: number) => {
    const { prefix, digits } = await getSettings({ prefix: LIBRARY.accessionPrefix, digits: LIBRARY.accessionDigits });
    const fmt = (n: number) => `${prefix}${String(n).padStart(digits, '0')}`;
    const first = await takeNumbers('library_accession', 1, count);
    const out = Array.from({ length: count }, (_, i) => fmt(first + i));
    // Numbers typed in by an import may already use some: skip those.
    const used = new Set((await db.bookCopy.findMany({ where: { accessionNo: { in: out } }, select: { accessionNo: true } })).map((c) => c.accessionNo));
    for (let i = 0; i < out.length; i++) {
        while (used.has(out[i])) {
            const n = fmt(await takeNumbers('library_accession', 1, 1));
            if (!(await db.bookCopy.findFirst({ where: { accessionNo: n }, select: { id: true } }))) out[i] = n;
        }
    }
    return out;
};

const searchWhere = (search?: string): Prisma.BookWhereInput =>
    search
        ? {
              OR: [
                  { title: { contains: search, mode: 'insensitive' } },
                  { authors: { contains: search, mode: 'insensitive' } },
                  { publisher: { contains: search, mode: 'insensitive' } },
                  { keywords: { contains: search, mode: 'insensitive' } },
                  { callNumber: { contains: search, mode: 'insensitive' } },
                  ...(normIsbn(search) && normIsbn(search)!.length >= 4 ? [{ isbn: { contains: normIsbn(search)! } }] : []),
                  { copies: { some: { accessionNo: { equals: search, mode: 'insensitive' } } } },
              ],
          }
        : {};

/** The catalogue, with how many copies each title has and how many are on the shelf. */
export const listBooks = async (q: z.infer<typeof booksQuery>, opts: { activeOnly?: boolean } = {}) => {
    const { newDays } = await getSettings({ newDays: LIBRARY.newArrivalsDays });
    const where: Prisma.BookWhereInput = {
        ...searchWhere(q.search),
        ...(q.category ? { categoryId: q.category } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.show === 'inactive' ? { isActive: false } : opts.activeOnly || q.show !== 'all' ? { isActive: true } : {}),
        ...(q.show === 'available' ? { copies: { some: { status: 'available' } } } : {}),
        ...(q.show === 'out' ? { copies: { some: { status: 'issued' } } } : {}),
        ...(q.show === 'new' ? { createdAt: { gte: new Date(Date.now() - newDays * 86_400_000) } } : {}),
    };
    const [total, rows] = await Promise.all([db.book.count({ where }), db.book.findMany({ where, orderBy: q.show === 'new' ? { createdAt: 'desc' } : { title: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const [copies, masters] = await Promise.all([
        db.bookCopy.groupBy({ by: ['bookId', 'status'], where: { bookId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
        db.masterValue.findMany({ where: { master: { in: ['library_category', 'library_language', 'library_location'] } }, select: { id: true, name: true } }),
    ]);
    const name = (id: string | null) => (id ? (masters.find((m) => m.id === id)?.name ?? null) : null);
    const count = (id: string, st?: string) => copies.filter((c) => c.bookId === id && (!st || c.status === st)).reduce((a, c) => a + c._count._all, 0);
    return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        rows: rows.map((b) => ({
            id: b.id,
            title: b.title,
            subtitle: b.subtitle,
            authors: b.authors,
            publisher: b.publisher,
            year: b.year,
            isbn: b.isbn,
            kind: b.kind,
            category: name(b.categoryId),
            language: name(b.languageId),
            location: name(b.locationId),
            callNumber: b.callNumber,
            coverFileId: b.coverFileId,
            link: b.link,
            hasFile: !!b.fileId,
            isActive: b.isActive,
            isNew: b.createdAt.getTime() >= Date.now() - newDays * 86_400_000,
            copies: count(b.id) - count(b.id, 'withdrawn'),
            available: count(b.id, 'available'),
            out: count(b.id, 'issued'),
        })),
    };
};

/** One title with its copies (who has each), and the reservation queue. */
export const getBook = async (id: string, opts: { members?: boolean } = { members: true }) => {
    const b = await db.book.findFirst({ where: { id } });
    if (!b) throw notFound('Book not found');
    const [copies, loans, reservations, masters] = await Promise.all([
        db.bookCopy.findMany({ where: { bookId: id }, orderBy: { accessionNo: 'asc' } }),
        db.libraryLoan.findMany({ where: { bookId: id, status: 'out' } }),
        db.libraryReservation.findMany({ where: { bookId: id, status: { in: ['waiting', 'ready'] } }, orderBy: { createdAt: 'asc' } }),
        db.masterValue.findMany({ where: { master: { in: ['library_category', 'library_language', 'library_location', 'book_condition'] } }, select: { id: true, name: true } }),
    ]);
    const name = (mid: string | null) => (mid ? (masters.find((m) => m.id === mid)?.name ?? null) : null);
    const names = opts.members ? await memberNames([...loans, ...reservations]) : new Map<string, string>();
    const today = todayIST();
    return {
        ...b,
        category: name(b.categoryId),
        language: name(b.languageId),
        location: name(b.locationId),
        copies: copies.map((c) => {
            const l = loans.find((x) => x.copyId === c.id);
            return {
                id: c.id,
                accessionNo: c.accessionNo,
                status: c.status,
                conditionId: c.conditionId,
                condition: name(c.conditionId),
                locationId: c.locationId,
                location: name(c.locationId ?? b.locationId),
                acquiredOn: c.acquiredOn ? isoOf(c.acquiredOn) : null,
                source: c.source,
                billNo: c.billNo,
                price: c.price,
                notes: c.notes,
                loan: l ? { id: l.id, member: opts.members ? (names.get(l.studentId ?? l.staffId ?? '') ?? '') : null, dueOn: isoOf(l.dueOn), overdue: isoOf(l.dueOn) < today } : null,
            };
        }),
        reservations: reservations.map((r, i) => ({ id: r.id, place: i + 1, status: r.status, member: opts.members ? (names.get(r.studentId ?? r.staffId ?? '') ?? '') : null, holdUntil: r.holdUntil ? isoOf(r.holdUntil) : null, createdAt: r.createdAt })),
    };
};

const bookData = (input: z.infer<typeof bookSchema>) => {
    const { copies: _c, ...rest } = input;
    const n = <T>(v: T | undefined | null) => (v === undefined || v === '' ? null : v);
    return { ...rest, subtitle: n(rest.subtitle), authors: n(rest.authors), publisher: n(rest.publisher), edition: n(rest.edition), year: n(rest.year), isbn: normIsbn(rest.isbn), categoryId: n(rest.categoryId), languageId: n(rest.languageId), locationId: n(rest.locationId), callNumber: n(rest.callNumber), level: n(rest.level), price: n(rest.price), pages: n(rest.pages), keywords: n(rest.keywords), coverFileId: n(rest.coverFileId), fileId: n(rest.fileId), link: n(rest.link), notes: n(rest.notes) };
};

export const saveBook = async (id: string | null, input: z.infer<typeof bookSchema>, userId: string) => {
    const data = bookData(input);
    if (data.isbn) {
        const same = await db.book.findFirst({ where: { isbn: data.isbn, ...(id ? { id: { not: id } } : {}) }, select: { id: true, title: true } });
        if (same) throw badRequest(`This ISBN is already in the catalogue (${same.title}); add copies to it instead`, [{ field: 'isbn', message: 'is already in the catalogue' }]);
    }
    const b = id ? await db.book.update({ where: { id }, data }) : await db.book.create({ data: { ...data, tenantId: getTenantId()!, createdBy: userId } });
    if (!id && input.copies) await addCopies(b.id, { count: input.copies, acquiredOn: todayIST(), source: 'purchase', price: data.price ?? null, billNo: null, locationId: null }, userId);
    await recordAudit({ action: id ? 'book_changed' : 'book_added', entity: 'book', entityId: b.id, changes: { title: b.title } });
    return getBook(b.id);
};

export const deleteBook = async (id: string) => {
    if (await db.libraryLoan.count({ where: { bookId: id } })) throw conflict('This book has been lent; make it inactive (or withdraw its copies) instead.');
    await db.libraryReservation.deleteMany({ where: { bookId: id } });
    await db.book.delete({ where: { id } });
    await recordAudit({ action: 'book_deleted', entity: 'book', entityId: id, changes: {} });
    return { id, deleted: true };
};

export const copiesSchema = z.strictObject({
    count: z.number().int().min(1).max(200),
    acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    source: z.enum(['purchase', 'donation', 'other']).nullable().optional(),
    price: z.number().int().min(0).max(1_000_000).nullable().optional(),
    billNo: z.string().trim().max(60).nullable().optional(),
    locationId: z.uuid().nullable().optional(),
});

/** Adds copies of a title, each with the next accession number. */
export const addCopies = async (bookId: string, input: z.infer<typeof copiesSchema>, userId: string) => {
    const b = await db.book.findFirst({ where: { id: bookId }, select: { id: true, title: true, price: true } });
    if (!b) throw notFound('Book not found');
    const numbers = await newAccessionNumbers(input.count);
    const condition = await db.masterValue.findFirst({ where: { master: 'book_condition', name: 'New' }, select: { id: true } });
    await db.bookCopy.createMany({ data: numbers.map((accessionNo) => ({ tenantId: getTenantId()!, bookId, accessionNo, status: 'available', conditionId: condition?.id ?? null, locationId: input.locationId ?? null, acquiredOn: input.acquiredOn ? dayDate(input.acquiredOn) : null, source: input.source ?? null, price: input.price ?? b.price ?? null, billNo: input.billNo || null })) });
    await recordAudit({ action: 'copies_added', entity: 'book', entityId: bookId, changes: { count: input.count, from: numbers[0], to: numbers[numbers.length - 1] } });
    void userId;
    return { added: numbers.length, accessionNos: numbers };
};

export const copySchema = z.strictObject({
    accessionNo: z.string().trim().min(1).max(30),
    status: z.enum(['available', 'damaged', 'lost', 'withdrawn']),
    conditionId: z.uuid().nullable().optional(),
    locationId: z.uuid().nullable().optional(),
    acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    source: z.enum(['purchase', 'donation', 'other']).nullable().optional(),
    billNo: z.string().trim().max(60).nullable().optional(),
    price: z.number().int().min(0).max(1_000_000).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
});

export const updateCopy = async (id: string, input: z.infer<typeof copySchema>) => {
    const c = await db.bookCopy.findFirst({ where: { id } });
    if (!c) throw notFound('Copy not found');
    if (c.status === 'issued' && input.status !== 'available') throw badRequest('This copy is lent out; take it back at the counter first');
    if (await db.bookCopy.findFirst({ where: { accessionNo: { equals: input.accessionNo, mode: 'insensitive' }, id: { not: id } } })) throw badRequest('Another copy has this accession number', [{ field: 'accessionNo', message: 'is taken' }]);
    const status = c.status === 'issued' || c.status === 'on_hold' ? c.status : input.status;
    await db.bookCopy.update({ where: { id }, data: { accessionNo: input.accessionNo, status, conditionId: input.conditionId ?? null, locationId: input.locationId ?? null, acquiredOn: input.acquiredOn ? dayDate(input.acquiredOn) : null, source: input.source ?? null, billNo: input.billNo || null, price: input.price ?? null, notes: input.notes || null } });
    await recordAudit({ action: 'copy_changed', entity: 'book', entityId: c.bookId, changes: { accessionNo: input.accessionNo, status } });
    return getBook(c.bookId);
};

export const deleteCopy = async (id: string) => {
    const c = await db.bookCopy.findFirst({ where: { id } });
    if (!c) throw notFound('Copy not found');
    if (await db.libraryLoan.count({ where: { copyId: id } })) throw conflict('This copy has been lent before; mark it withdrawn instead.');
    await db.bookCopy.delete({ where: { id } });
    return getBook(c.bookId);
};

/** Copies for label printing: by title, or a range of accession numbers. */
export const labelsQuery = z.object({ book: z.uuid().optional(), from: z.string().trim().max(30).optional(), to: z.string().trim().max(30).optional(), ids: z.string().max(4000).optional() });
export const labels = async (q: z.infer<typeof labelsQuery>) => {
    const where: Prisma.BookCopyWhereInput = q.ids ? { id: { in: q.ids.split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)) } } : q.book ? { bookId: q.book } : q.from && q.to ? { accessionNo: { gte: q.from, lte: q.to } } : { id: '00000000-0000-0000-0000-000000000000' };
    const copies = await db.bookCopy.findMany({ where: { ...where, status: { not: 'withdrawn' } }, orderBy: { accessionNo: 'asc' }, take: 500, include: { book: { select: { title: true, authors: true, callNumber: true, locationId: true } } } });
    const locations = new Map((await db.masterValue.findMany({ where: { master: 'library_location' }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
    const school = await db.schoolProfile.findFirst({ select: { shortName: true, legalName: true } });
    return { school: school?.shortName ?? school?.legalName ?? '', labels: copies.map((c) => ({ id: c.id, accessionNo: c.accessionNo, title: c.book.title, authors: c.book.authors, callNumber: c.book.callNumber, location: locations.get(c.locationId ?? c.book.locationId ?? '') ?? null })) };
};

/** A copy by its accession number (what the scanner types). */
export const findCopy = async (accessionNo: string) => {
    const c = await db.bookCopy.findFirst({ where: { accessionNo: { equals: accessionNo.trim(), mode: 'insensitive' } }, include: { book: true } });
    if (!c) throw notFound(`No copy with the accession number ${accessionNo.trim()}`);
    return c;
};
