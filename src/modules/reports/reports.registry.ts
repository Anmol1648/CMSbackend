/**
 * Report library. Each module declares its reports (`<module>.reports.ts`): the filters, the columns,
 * who may run it and how its rows are gathered (already limited to what the person may see). The
 * Report Center shows them on screen and makes PDF / Excel / Word, with the school's Jasper design or
 * the built-in table layout.
 */

export type ReportFilterType = 'date' | 'year' | 'class' | 'section' | 'select' | 'text' | 'master' | 'exam';

export interface ReportFilter {
    key: string;
    label: string;
    type: ReportFilterType;
    required?: boolean;
    /** date: 'today' | 'monthStart' | 'yearStart' | 'sessionStart' | 'sessionEnd'; select: one of the options; year: 'current'. */
    default?: string;
    /** select: the choices (value '' = all). */
    options?: { value: string; label: string }[];
    /** master: the list whose options are offered (their codes are the values; empty = all). */
    master?: string;
    help?: string;
}

export type ReportColumnType = 'text' | 'number' | 'money' | 'date';

export interface ReportColumn {
    key: string;
    label: string;
    type: ReportColumnType;
    /** Relative width in the built-in layout (default 1). */
    width?: number;
    /** Add it up (group subtotals and the grand total). */
    total?: boolean;
}

export interface ReportContext {
    userId: string;
}

export interface ReportResult {
    /** One object per row, keyed by the column keys. With grouping, each row also has groupKey and groupLabel. */
    rows: Record<string, unknown>[];
    /** The filters in words ("1 Apr – 21 Oct 2026 · Class 8"), under the title. */
    subtitle?: string;
    /** What the rows are grouped by ("Class"), when they are. */
    groupedBy?: string | null;
}

export interface ReportDef {
    key: string;
    /** Section of the library ("Fees", "Admissions"…). */
    category: string;
    label: string;
    description: string;
    /** Any one of these lets a person run it. */
    permissions: string[];
    filters: ReportFilter[];
    columns: ReportColumn[];
    orientation: 'portrait' | 'landscape';
    /** The built-in Jasper design (file name in reports/jasper/), if the report has one. */
    jasper?: string;
    run(filters: Record<string, string>, ctx: ReportContext): Promise<ReportResult>;
}

/** Fields every Jasper design may use as parameters (the letterhead and the report's title). */
export const COMMON_PARAMETERS: { name: string; type: string; description: string }[] = [
    { name: 'SCHOOL_NAME', type: 'java.lang.String', description: 'School name' },
    { name: 'SCHOOL_ADDRESS', type: 'java.lang.String', description: 'Address on one line' },
    { name: 'SCHOOL_CONTACT', type: 'java.lang.String', description: 'Phone · email · website' },
    { name: 'SCHOOL_CODES', type: 'java.lang.String', description: 'Affiliation no. · UDISE code' },
    { name: 'SCHOOL_LOGO', type: 'java.io.InputStream', description: 'The logo (empty when there is none)' },
    { name: 'REPORT_TITLE', type: 'java.lang.String', description: 'The report’s name' },
    { name: 'REPORT_SUBTITLE', type: 'java.lang.String', description: 'The filters in words' },
    { name: 'GROUPED_BY', type: 'java.lang.String', description: 'What the rows are grouped by (empty = not grouped)' },
    { name: 'PRINTED_BY', type: 'java.lang.String', description: 'Who made the report' },
    { name: 'PRINTED_AT', type: 'java.lang.String', description: 'When it was made, e.g. 21 Oct 2026, 3:40 pm' },
];

/** Fields every row has when the report is grouped. */
export const GROUP_FIELDS: ReportColumn[] = [
    { key: 'groupKey', label: 'Group (for sorting)', type: 'text' },
    { key: 'groupLabel', label: 'Group heading', type: 'text' },
];

const reports = new Map<string, ReportDef>();
const categoryOrder = new Map<string, number>();

export const defineReport = (def: ReportDef) => {
    if (reports.has(def.key)) throw new Error(`Report "${def.key}" is defined twice`);
    reports.set(def.key, def);
    return def;
};

export const registerReportCategory = (name: string, order: number) => categoryOrder.set(name, order);
export const categoryRank = (name: string) => categoryOrder.get(name) ?? 999;

export const findReportDef = (key: string) => reports.get(key);
export const listReportDefs = () => [...reports.values()];
