import ExcelJS from 'exceljs';
import { db } from '../db';
import { getContext, getTenantId } from '../context';

/**
 * The look of every Excel export (page exports and the Report Center alike): the school's name and the
 * report's title on top, a navy heading row that stays in view with filters, dates as dates, amounts
 * in lakhs / crores, group headings and subtotals, a grand total, and who made it and when.
 */

export type SheetColumnType = 'text' | 'number' | 'money' | 'date';

export interface SheetColumn<T> {
    header: string;
    width?: number;
    /** How values show (default: as they are). */
    type?: SheetColumnType;
    /** Add it up (group subtotals and the grand total). */
    total?: boolean;
    value: (row: T) => string | number | Date | null | undefined;
}

export interface StyledSheet<T> {
    title: string;
    /** The filters in words, under the title. */
    subtitle?: string;
    sheetName?: string;
    columns: SheetColumn<T>[];
    rows: T[];
    /** Rows in groups (with a heading and a subtotal each); "groupedBy" names what they are grouped by. */
    groups?: { label: string; rows: T[] }[];
    groupedBy?: string | null;
}

const NAVY = 'FF1A365D';
const MONEY = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"##,##0';
const NUMBER = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const sheetName = (name: string) => name.replace(/[*?:\\/[\]]+/g, ' ').trim().slice(0, 31) || 'Sheet1';

/** The school's name and the signed-in person (for the top and the bottom of the sheet). */
const whoAndWhere = async () => {
    const tenantId = getTenantId();
    const userId = getContext()?.user?.id;
    const [profile, tenant, user] = await Promise.all([
        tenantId ? db.schoolProfile.findUnique({ where: { tenantId }, select: { legalName: true } }).catch(() => null) : null,
        tenantId ? db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null) : null,
        userId ? db.user.findUnique({ where: { id: userId }, select: { displayName: true } }).catch(() => null) : null,
    ]);
    return { school: profile?.legalName || tenant?.name || '', user: user?.displayName ?? '' };
};

export const buildStyledWorkbook = async <T>(sheet: StyledSheet<T>): Promise<Buffer> => {
    const { school, user } = await whoAndWhere();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Klytos Labs School ERP';
    const ws = wb.addWorksheet(sheetName(sheet.sheetName ?? sheet.title));
    const cols = sheet.columns;
    const span = Math.max(cols.length, 1);

    // Widths: as given, else from the heading and the values (within reason).
    ws.columns = cols.map((c) => {
        if (c.width) return { width: c.width };
        const longest = sheet.rows.slice(0, 300).reduce((m, r) => Math.max(m, String(c.value(r) ?? '').length), c.header.length);
        return { width: Math.min(45, Math.max(10, longest + 3)) };
    });

    const title = (text: string, size: number, bold = true, color = 'FF111111') => {
        const r = ws.addRow([text]);
        r.font = { bold, size, color: { argb: color } };
        ws.mergeCells(r.number, 1, r.number, span);
    };
    if (school) title(school.toUpperCase(), 14, true, NAVY);
    title(sheet.title, 12);
    if (sheet.subtitle) title(sheet.subtitle, 10, false, 'FF555555');
    ws.addRow([]);

    const head = ws.addRow(cols.map((c) => c.header));
    head.height = 20;
    head.eachCell((cell, n) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
        cell.alignment = { vertical: 'middle', horizontal: cols[n - 1]?.type === 'money' || cols[n - 1]?.type === 'number' ? 'right' : 'left' };
    });
    ws.views = [{ state: 'frozen', ySplit: head.number }];

    const value = (c: SheetColumn<T>, row: T) => {
        const v = c.value(row);
        if (c.type === 'date' && typeof v === 'string' && ISO_DATE.test(v)) return new Date(`${v}T00:00:00Z`);
        return v ?? null;
    };
    const put = (values: (string | number | Date | null)[], style?: { bold?: boolean; fill?: string; size?: number }) => {
        const r = ws.addRow(values);
        cols.forEach((c, i) => {
            const cell = r.getCell(i + 1);
            if (c.type === 'money') cell.numFmt = MONEY;
            else if (c.type === 'number') cell.numFmt = NUMBER;
            else if (c.type === 'date') cell.numFmt = 'dd-mmm-yyyy';
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFDDDDDD' } } };
            if (style?.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
        });
        if (style?.bold) r.font = { bold: true, size: style.size ?? 11 };
        return r;
    };
    const hasTotals = cols.some((c) => c.total);
    const totals = (label: string, rows: T[], style: { fill?: string; size?: number }) => {
        const sums = cols.map((c) => (c.total ? rows.reduce((a, r) => a + (Number(c.value(r)) || 0), 0) : null));
        put(cols.map((_, i) => (i === 0 ? `${label} (${rows.length})` : sums[i])), { bold: true, ...style });
    };

    const firstData = head.number + 1;
    if (sheet.groups?.length) {
        for (const g of sheet.groups) {
            const r = ws.addRow([`${sheet.groupedBy ? `${sheet.groupedBy}: ` : ''}${g.label}`]);
            r.font = { bold: true, color: { argb: NAVY } };
            r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
            ws.mergeCells(r.number, 1, r.number, span);
            for (const row of g.rows) put(cols.map((c) => value(c, row)));
            if (hasTotals && sheet.groups.length > 1) totals(`Total for ${g.label}`, g.rows, {});
        }
    } else {
        for (const row of sheet.rows) put(cols.map((c) => value(c, row)));
        // Filters on the heading row (only for a plain list: group headings would get in the way).
        if (sheet.rows.length) ws.autoFilter = { from: { row: head.number, column: 1 }, to: { row: head.number + sheet.rows.length, column: span } };
    }
    if (!sheet.rows.length) {
        const r = ws.addRow(['Nothing to show.']);
        r.font = { italic: true, color: { argb: 'FF777777' } };
        ws.mergeCells(r.number, 1, r.number, span);
    } else if (hasTotals) totals('Grand total', sheet.rows, { fill: 'FFF1F5F9', size: 11 });
    void firstData;

    ws.addRow([]);
    const printed = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    const foot = ws.addRow([`${user ? `Printed by ${user} on ` : 'Printed on '}${printed} · Klytos Labs School ERP`]);
    foot.font = { italic: true, size: 9, color: { argb: 'FF666666' } };
    ws.mergeCells(foot.number, 1, foot.number, span);
    ws.pageSetup = { orientation: cols.length > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    return Buffer.from(await wb.xlsx.writeBuffer());
};
