import ExcelJS from 'exceljs';

/**
 * Excel engine shared by every module.
 *   - buildTemplate(def): Data sheet with headers (* = required), a tip when a cell is selected,
 *     dropdowns for choice and list columns, an Instructions sheet (what each column means, an
 *     example) and an "Allowed values" sheet (every choice and what it means).
 *   - parseRows(def, buffer): reads an uploaded workbook into typed rows with per-cell problems.
 *   - buildWorkbook(columns, rows): plain export / error report.
 */

export type ColumnType = 'text' | 'email' | 'mobile' | 'number' | 'date' | 'choice' | 'list';

export interface ImportColumn {
    key: string;
    header: string;
    type: ColumnType;
    required?: boolean;
    /** Values must be unique within the file (case-insensitive). */
    unique?: boolean;
    /** choice / list: allowed values (shown as a dropdown; list = comma-separated several). */
    choices?: string[];
    /** choice / list: what each value means (shown on the "Allowed values" sheet and the import screen). */
    choiceHelp?: Record<string, string>;
    max?: number;
    help?: string;
    example?: string;
}

export type CellValue = string | number | Date | string[] | null;

export interface ParsedRow {
    /** Row number in the sheet (header is row 1). */
    row: number;
    values: Record<string, CellValue>;
    issues: { field: string; message: string }[];
}

export interface ParseResult {
    rows: ParsedRow[];
    /** Problems with the sheet itself (missing required columns, too many rows…). */
    problems: string[];
}

const DATA_SHEET = 'Data';
const LISTS_SHEET = 'Lists';

const headerLabel = (c: ImportColumn) => `${c.header}${c.required ? ' *' : ''}`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s*\*$/, '').replace(/\s+/g, ' ');

/** The tip shown in Excel when a cell of this column is selected. */
const cellTip = (c: ImportColumn) =>
    [
        c.required ? 'Required.' : null,
        c.help,
        c.type === 'choice' ? 'Pick from the list.' : null,
        c.type === 'list' ? 'Pick one from the list, or type several separated by commas. All options: "Allowed values" sheet.' : null,
        c.type === 'date' ? 'A date like 15-08-2012.' : null,
        c.example ? `Example: ${c.example}` : null,
    ]
        .filter((t): t is string => !!t)
        .map((t) => (/[.!?]$/.test(t) ? t : `${t}.`))
        .join(' ');

export const buildTemplate = async (columns: ImportColumn[], title: string, maxRows: number): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'School ERP';
    const data = wb.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
    data.columns = columns.map((c) => ({ header: headerLabel(c), key: c.key, width: Math.max(16, headerLabel(c).length + 4) }));
    const head = data.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A365D' } };
    columns.forEach((c, i) => {
        if (c.help) head.getCell(i + 1).note = c.help;
    });

    // Dropdowns: choice lists live on a hidden sheet so long lists work. A tip shows when a cell is
    // selected (Excel shows at most 255 characters of it).
    const lists = wb.addWorksheet(LISTS_SHEET, { state: 'veryHidden' });
    let listCol = 0;
    for (const [i, c] of columns.entries()) {
        const tip = cellTip(c).slice(0, 255);
        // A length rule carries the tip (Excel has no "tip only" rule) and enforces the column's maximum.
        let validation: ExcelJS.DataValidation | null = tip
            ? {
                  type: 'textLength',
                  operator: 'lessThanOrEqual',
                  allowBlank: true,
                  formulae: [c.max ?? 32767],
                  showInputMessage: true,
                  promptTitle: c.header.slice(0, 32),
                  prompt: tip,
                  showErrorMessage: !!c.max,
                  errorTitle: c.header.slice(0, 32),
                  error: `At most ${c.max} characters`,
              }
            : null;
        if ((c.type === 'choice' || c.type === 'list') && c.choices?.length) {
            listCol++;
            c.choices.forEach((v, r) => (lists.getCell(r + 1, listCol).value = v));
            const letter = lists.getColumn(listCol).letter;
            const range = `${LISTS_SHEET}!$${letter}$1:$${letter}$${c.choices.length}`;
            validation = {
                ...validation,
                operator: undefined,
                type: 'list',
                allowBlank: !c.required,
                formulae: [range],
                // A list column takes several values typed with commas, so Excel must not refuse them.
                showErrorMessage: c.type === 'choice',
                errorTitle: c.header.slice(0, 32),
                error: 'Pick a value from the list',
            };
        }
        if (!validation) continue;
        for (let r = 2; r <= maxRows + 1; r++) data.getCell(r, i + 1).dataValidation = validation;
    }

    const help = wb.addWorksheet('Instructions');
    help.columns = [{ width: 28 }, { width: 12 }, { width: 70 }, { width: 30 }];
    help.addRow([title]).font = { bold: true, size: 14 };
    help.addRow([`Fill in the "${DATA_SHEET}" sheet, one row per record, then upload the file. Columns marked * are required. At most ${maxRows} rows per file.`]);
    help.addRow([]);
    const h = help.addRow(['Column', 'Required', 'What to enter', 'Example']);
    h.font = { bold: true };
    for (const c of columns) {
        const what = [c.help, c.type === 'choice' && c.choices ? `One of: ${c.choices.join(', ')}` : null, c.type === 'list' && c.choices ? `Comma-separated, from: ${c.choices.join(', ')}` : null, c.type === 'date' ? 'A date (DD-MM-YYYY)' : null]
            .filter(Boolean)
            .join('. ');
        help.addRow([c.header, c.required ? 'Yes' : '', what, c.example ?? '']);
    }

    // Every allowed value with its meaning, so nobody has to guess role or type names.
    const withChoices = columns.filter((c) => (c.type === 'choice' || c.type === 'list') && c.choices?.length);
    if (withChoices.length) {
        const allowed = wb.addWorksheet('Allowed values');
        allowed.columns = [{ width: 26 }, { width: 80 }];
        for (const c of withChoices) {
            const t = allowed.addRow([c.header, c.type === 'list' ? 'Use one or more, separated by commas' : 'Use one of these']);
            t.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A365D' } };
            for (const v of c.choices!) allowed.addRow([v, c.choiceHelp?.[v] ?? '']);
            allowed.addRow([]);
        }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
};

/** Plain text of whatever Excel put in a cell (rich text, hyperlinks, formulas, numbers). */
const cellText = (v: ExcelJS.CellValue): string | number | Date | null => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date || typeof v === 'number') return v;
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'object') {
        if ('richText' in v) return v.richText.map((t) => t.text).join('');
        if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
        if ('result' in v) return cellText(v.result as ExcelJS.CellValue); // formula
    }
    return String(v);
};

const parseDate = (v: string | number | Date): Date | null => {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const s = String(v).trim();
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/) ?? null;
    if (m) {
        const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
        return d.getUTCDate() === Number(m[1]) ? d : null;
    }
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return iso ? new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))) : null;
};

const checkCell = (c: ImportColumn, raw: string | number | Date | null): { value: CellValue; issue?: string } => {
    const text = raw === null ? '' : raw instanceof Date ? '' : String(raw).trim();
    if (raw === null || (text === '' && !(raw instanceof Date))) return c.required ? { value: null, issue: 'is required' } : { value: null };
    if (c.max && text.length > c.max) return { value: null, issue: `must be at most ${c.max} characters` };
    switch (c.type) {
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? { value: text.toLowerCase() } : { value: null, issue: 'is not a valid email' };
        case 'mobile':
            return /^\+?[0-9][0-9 ()-]{5,19}$/.test(text) ? { value: text } : { value: null, issue: 'is not a valid mobile number' };
        case 'number': {
            const n = typeof raw === 'number' ? raw : Number(text);
            return Number.isFinite(n) ? { value: n } : { value: null, issue: 'must be a number' };
        }
        case 'date': {
            const d = parseDate(raw);
            return d ? { value: d } : { value: null, issue: 'must be a date like 15-08-2012' };
        }
        case 'choice': {
            const hit = c.choices?.find((ch) => ch.toLowerCase() === text.toLowerCase());
            return hit ? { value: hit } : { value: null, issue: `must be one of: ${c.choices?.join(', ')}` };
        }
        case 'list': {
            const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
            const values: string[] = [];
            for (const p of parts) {
                const hit = c.choices?.find((ch) => ch.toLowerCase() === p.toLowerCase());
                if (!hit) return { value: null, issue: `"${p}" is not one of: ${c.choices?.join(', ')}` };
                if (!values.includes(hit)) values.push(hit);
            }
            return { value: values };
        }
        default:
            return { value: text };
    }
};

export const parseRows = async (columns: ImportColumn[], data: Buffer, maxRows: number): Promise<ParseResult> => {
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
    } catch {
        return { rows: [], problems: ['The file could not be read as an Excel workbook (.xlsx).'] };
    }
    const sheet = wb.getWorksheet(DATA_SHEET) ?? wb.worksheets.find((w) => w.state === 'visible');
    if (!sheet) return { rows: [], problems: ['The workbook has no sheets.'] };

    // Map header cells to columns (case and " *" ignored); unknown columns are ignored.
    const positions = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, col) => {
        const name = norm(String(cellText(cell.value) ?? ''));
        const c = columns.find((x) => norm(x.header) === name || x.key.toLowerCase() === name);
        if (c && !positions.has(c.key)) positions.set(c.key, col);
    });
    const missing = columns.filter((c) => c.required && !positions.has(c.key)).map((c) => c.header);
    if (missing.length) return { rows: [], problems: [`Required column${missing.length > 1 ? 's are' : ' is'} missing: ${missing.join(', ')}. Download a fresh template.`] };

    const rows: ParsedRow[] = [];
    const problems: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const raw = new Map(columns.map((c) => [c.key, positions.has(c.key) ? cellText(row.getCell(positions.get(c.key)!).value) : null]));
        if ([...raw.values()].every((v) => v === null || (typeof v === 'string' && v.trim() === ''))) return;
        const parsed: ParsedRow = { row: rowNumber, values: {}, issues: [] };
        for (const c of columns) {
            const { value, issue } = checkCell(c, raw.get(c.key) ?? null);
            parsed.values[c.key] = value;
            if (issue) parsed.issues.push({ field: c.header, message: issue });
        }
        rows.push(parsed);
    });
    if (rows.length > maxRows) problems.push(`The file has ${rows.length} rows; at most ${maxRows} can be imported at once. Split it into smaller files.`);
    if (!rows.length) problems.push('The file has no rows to import.');

    // Duplicates inside the file.
    for (const c of columns.filter((x) => x.unique)) {
        const seen = new Map<string, number>();
        for (const r of rows) {
            const v = r.values[c.key];
            if (v === null || v === undefined) continue;
            const k = String(v).toLowerCase();
            if (seen.has(k)) r.issues.push({ field: c.header, message: `is the same as row ${seen.get(k)}` });
            else seen.set(k, r.row);
        }
    }
    return { rows, problems };
};

export interface ExportColumn<T> {
    header: string;
    width?: number;
    value: (row: T) => string | number | Date | null | undefined;
}

/**
 * A name Excel accepts for a sheet: none of * ? : \ / [ ], no leading or trailing apostrophe,
 * at most 31 characters ("States / UTs" → "States - UTs").
 */
export const safeSheetName = (name: string) =>
    name
        .replace(/\s*[*?:\\/[\]]+\s*/g, ' - ')
        .replace(/^'+|'+$/g, '')
        .trim()
        .slice(0, 31)
        .trim() || 'Sheet1';

export const buildWorkbook = async <T>(sheetName: string, columns: ExportColumn<T>[], rows: T[]): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'School ERP';
    const ws = wb.addWorksheet(safeSheetName(sheetName), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, width: c.width ?? Math.max(14, c.header.length + 4) }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(columns.map((c) => c.value(r) ?? null));
    return Buffer.from(await wb.xlsx.writeBuffer());
};

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
