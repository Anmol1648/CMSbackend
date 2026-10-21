import type { Paper } from '../../core/pdf';

/**
 * Documents (fee receipt, fee due slip, TC, ID card…): each module declares its own here, with a
 * default template (HTML + CSS, Handlebars), the paper it prints on, the fields a template may use,
 * and how it loads a record (checking who may see it). Schools reword / restyle a template in
 * Setup → Document Templates; the PDF is always made on the server, so it looks the same everywhere.
 */

export interface DocumentField {
    /** As used in the template, e.g. "receipt.receiptNo" or "#each receipt.instalments". */
    key: string;
    label: string;
}

export interface DocumentPaper extends Paper {
    /** Copies on separate pages (e.g. "School copy", "Parent copy"); the template gets {{copy}}. */
    copies: string[];
    /** Put the copies on the same page, with a dashed "cut here" line between them. */
    copiesOnOnePage?: boolean;
}

export interface LoadedDocument {
    /** What the template draws, besides {{school}} and {{copy}}. */
    data: Record<string, unknown>;
    filename: string;
    /** Several of the same document in one PDF (e.g. a slip per student of a class). */
    many?: Record<string, unknown>[];
}

export interface DocumentDef {
    key: string;
    label: string;
    description: string;
    /** Permission to edit this template (default documents.manage); viewing is decided by `load`. */
    fields: DocumentField[];
    html: string;
    css: string;
    paper: DocumentPaper;
    /** A record to preview the template with (the latest real one, or made-up values). */
    sample: () => Promise<LoadedDocument>;
    /** The document for a request (`params` from the URL), for the signed-in `userId`; throws if not allowed. */
    load: (params: Record<string, string>, userId: string) => Promise<LoadedDocument>;
}

const registry = new Map<string, DocumentDef>();

export const defineDocument = (def: DocumentDef) => {
    if (registry.has(def.key)) throw new Error(`Document "${def.key}" is defined twice`);
    registry.set(def.key, def);
    return def;
};

export const listDocumentDefs = () => [...registry.values()];
export const findDocumentDef = (key: string) => registry.get(key);

/** Fields every template has. */
export const COMMON_FIELDS: DocumentField[] = [
    { key: 'school.name', label: 'School name (as on the school profile)' },
    { key: 'school.shortName', label: 'Short name' },
    { key: 'school.address', label: 'Address (one line)' },
    { key: 'school.phone', label: 'Phone' },
    { key: 'school.email', label: 'Email' },
    { key: 'school.website', label: 'Website' },
    { key: 'school.affiliationNo', label: 'Board affiliation no.' },
    { key: 'school.udiseCode', label: 'UDISE code' },
    { key: 'school.logo', label: 'Logo (use as <img src="{{school.logo}}">)' },
    { key: 'copy', label: 'Which copy this page is ("School copy"…)' },
    { key: 'today', label: 'Today’s date' },
    { key: 'rupees x', label: 'Helper: ₹1,250 from a number, e.g. {{rupees amount}}' },
    { key: 'date x', label: 'Helper: 21 Oct 2026 from a date, e.g. {{date receipt.date}}' },
    { key: 'inWords x', label: 'Helper: an amount in words (Indian), e.g. {{inWords amount}}' },
];
