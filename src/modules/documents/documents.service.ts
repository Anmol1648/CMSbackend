import Handlebars from 'handlebars';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { readFile } from '../../core/files';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { COMMON_FIELDS, DocumentDef, DocumentPaper, findDocumentDef, listDocumentDefs, LoadedDocument } from './documents.registry';

/** Making documents (PDF) from their templates, and the schools' own versions of the templates. */

// ─── Template language ───────────────────────────────────────────────────────

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
/** 125450 → "One Lakh Twenty Five Thousand Four Hundred Fifty" (the Indian way). */
export const inWords = (n: number) => {
    n = Math.round(Math.abs(n));
    if (!n) return 'Zero';
    const parts: string[] = [];
    const crore = Math.floor(n / 10_000_000);
    const lakh = Math.floor((n % 10_000_000) / 100_000);
    const thousand = Math.floor((n % 100_000) / 1000);
    if (crore) parts.push(`${three(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (n % 1000) parts.push(three(n % 1000));
    return parts.join(' ');
};

const hb = Handlebars.create();
hb.registerHelper('rupees', (v: unknown) => (typeof v === 'number' ? `₹${v.toLocaleString('en-IN')}` : '—'));
hb.registerHelper('inWords', (v: unknown) => (typeof v === 'number' ? inWords(v) : ''));
hb.registerHelper('date', (v: unknown) => {
    if (!v) return '—';
    const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : String(v));
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
});
hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
hb.registerHelper('gt', (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && a > b);
hb.registerHelper('upper', (v: unknown) => String(v ?? '').toUpperCase());

const compile = (html: string) => {
    try {
        // Handlebars checks a template only when it first runs: check it now (and say where).
        hb.precompile(html);
        return hb.compile(html, { strict: false, noEscape: false });
    } catch (err) {
        throw badRequest(`The template has a mistake: ${(err as Error).message.split('\n')[0]}`, [{ field: 'html', message: (err as Error).message.split('\n').slice(0, 3).join(' ') }]);
    }
};

// ─── The school's letterhead ─────────────────────────────────────────────────

const schoolContext = async () => {
    const p = await db.schoolProfile.findUnique({ where: { tenantId: getTenantId()! }, include: { tenant: { select: { name: true } } } });
    let logo: string | null = null;
    if (p?.logoFileId) {
        try {
            const { file, data } = await readFile(p.logoFileId);
            logo = `data:${file.mimeType};base64,${data.toString('base64')}`;
        } catch {
            logo = null;
        }
    }
    const address = p ? [p.addressLine1, p.addressLine2, p.city, p.district, p.state, p.pincode].filter(Boolean).join(', ') : '';
    return {
        name: p?.legalName || p?.tenant.name || '',
        shortName: p?.shortName || p?.tenant.name || '',
        address,
        phone: p?.phone ?? '',
        email: p?.email ?? '',
        website: p?.website ?? '',
        affiliationNo: p?.affiliationNo ?? '',
        udiseCode: p?.udiseCode ?? '',
        logo,
    };
};

// ─── Templates ───────────────────────────────────────────────────────────────

export const paperSchema = z.strictObject({
    size: z.enum(['A4', 'A5', 'A4_HALF', 'THERMAL_80']),
    orientation: z.enum(['portrait', 'landscape']),
    margin: z.number().min(0).max(30),
    copies: z.array(z.string().trim().max(40)).min(1).max(4),
    copiesOnOnePage: z.boolean().optional(),
});

const templateOf = async (def: DocumentDef) => {
    const own = await db.documentTemplate.findFirst({ where: { key: def.key } });
    return {
        html: own?.html ?? def.html,
        css: own?.css ?? def.css,
        paper: { ...def.paper, ...((own?.paper as Partial<DocumentPaper> | undefined) ?? {}) } as DocumentPaper,
        custom: !!own,
        updatedAt: own?.updatedAt ?? null,
    };
};

const defOf = (key: string) => {
    const def = findDocumentDef(key);
    if (!def) throw notFound('No such document');
    return def;
};

export const listTemplates = async () => {
    const own = await db.documentTemplate.findMany({ select: { key: true, updatedAt: true } });
    return listDocumentDefs().map((d) => ({ key: d.key, label: d.label, description: d.description, custom: own.some((o) => o.key === d.key), updatedAt: own.find((o) => o.key === d.key)?.updatedAt ?? null, paper: d.paper }));
};

export const getTemplate = async (key: string) => {
    const def = defOf(key);
    const t = await templateOf(def);
    return { key: def.key, label: def.label, description: def.description, ...t, fields: [...def.fields, ...COMMON_FIELDS], defaults: { html: def.html, css: def.css, paper: def.paper } };
};

export const templateSchema = z.strictObject({ html: z.string().min(1, 'is required').max(200_000), css: z.string().max(100_000), paper: paperSchema });

export const saveTemplate = async (key: string, input: z.infer<typeof templateSchema>) => {
    const def = defOf(key);
    compile(input.html);
    const tenantId = getTenantId()!;
    const data = { html: input.html, css: input.css, paper: input.paper as unknown as Prisma.InputJsonValue };
    await db.documentTemplate.upsert({ where: { tenantId_key: { tenantId, key: def.key } }, create: { tenantId, key: def.key, ...data }, update: data });
    await recordAudit({ action: 'document_template_saved', entity: 'document_template', changes: { key: def.key } });
    return getTemplate(key);
};

export const resetTemplate = async (key: string) => {
    const def = defOf(key);
    await db.documentTemplate.deleteMany({ where: { key: def.key } });
    await recordAudit({ action: 'document_template_reset', entity: 'document_template', changes: { key: def.key } });
    return getTemplate(key);
};

// ─── Making the PDF ──────────────────────────────────────────────────────────

/** The full HTML page of a document (what becomes the PDF). */
export const documentHtml = async (tpl: { html: string; css: string; paper: DocumentPaper }, doc: LoadedDocument) => {
    const render = compile(tpl.html);
    const school = await schoolContext();
    const today = new Date().toISOString().slice(0, 10);
    const items = doc.many?.length ? doc.many : [doc.data];
    const pages: string[] = [];
    const one = (item: Record<string, unknown>, copy: string) => `<section class="no-break document-page">${render({ ...item, school, copy, today }, { allowProtoPropertiesByDefault: false, allowProtoMethodsByDefault: false })}</section>`;
    for (const item of items) {
        if (tpl.paper.copiesOnOnePage) pages.push(tpl.paper.copies.map((copy) => one(item, copy)).join('<div class="cut-line"><span>✂ cut here</span></div>'));
        else for (const copy of tpl.paper.copies) pages.push(one(item, copy));
    }
    const body = pages.join('<div class="page-break"></div>');
    return pageHtml(body, tpl.css, tpl.paper);
};

const draw = async (tpl: { html: string; css: string; paper: DocumentPaper }, doc: LoadedDocument) => htmlToPdf(await documentHtml(tpl, doc), tpl.paper);

/** The template of a document as the school uses it (its own, or the built-in one). */
export const activeTemplate = (key: string) => templateOf(defOf(key));

/** A document for a record (the module's `load` checks the viewer may see it). */
export const renderDocument = async (key: string, params: Record<string, string>, userId: string) => {
    const def = defOf(key);
    const doc = await def.load(params, userId);
    return { pdf: await draw(await templateOf(def), doc), filename: doc.filename };
};

export const previewSchema = templateSchema.partial();

/** The template (as saved, or as being edited) drawn with a sample record. */
export const previewTemplate = async (key: string, input: z.infer<typeof previewSchema>) => {
    const def = defOf(key);
    const saved = await templateOf(def);
    const doc = await def.sample();
    return draw({ html: input.html ?? saved.html, css: input.css ?? saved.css, paper: input.paper ?? saved.paper }, doc);
};
