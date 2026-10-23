import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db';
import { getTenantId } from '../../core/context';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { buildStyledWorkbook } from '../../core/excel';
import { jasperHealth, jasperInspect, jasperRender, JasperUnavailableError } from '../../core/jasper';
import { logger } from '../../core/logger';
import { currentYear } from '../academic/years.service';
import { getUserAccess } from '../rbac/access.service';
import { schoolContext } from '../documents/documents.service';
import { categoryRank, COMMON_PARAMETERS, findReportDef, GROUP_FIELDS, listReportDefs, ReportColumn, ReportDef, ReportResult } from './reports.registry';
import { checkDefinition, CUSTOM_PREFIX, customReportDef, Definition, definitionReport, visibleCustomReports } from './builder.service';
import { generateJrxml } from './jrxml.generator';

/** The Report Center: runs reports, makes their files (Jasper or the built-in layout), keeps the schools' designs. */

export type Engine = 'auto' | 'jasper' | 'builtin';
export type ExportFormat = 'pdf' | 'xlsx' | 'docx';

/** At most this many rows are sent to the screen (files have them all). */
const SCREEN_ROWS = 5000;

// ─── Access ──────────────────────────────────────────────────────────────────

const access = (userId: string) => getUserAccess(userId);
const mayRun = (def: ReportDef, permissions: Record<string, unknown>) => def.permissions.some((p) => permissions[p]);

const defFor = async (key: string, userId: string) => {
    // A report made in the Report Builder, or one of the modules'.
    const def = key.startsWith(CUSTOM_PREFIX) ? await customReportDef(key, userId) : findReportDef(key);
    if (!def) throw notFound('No such report');
    const a = await access(userId);
    if (!mayRun(def, a.permissions)) throw forbidden('You can’t run this report');
    return { def, canDesign: !!a.permissions['report.design'] };
};

const needDesign = async (userId: string) => {
    if (!(await access(userId)).permissions['report.design']) throw forbidden();
};

// ─── Built-in designs (reports/jasper/*.jrxml) ───────────────────────────────

// src/modules/reports and dist/modules/reports both sit three levels below the backend folder.
const DESIGN_DIR = path.join(__dirname, '..', '..', '..', 'reports', 'jasper');
const builtIns = new Map<string, string>();
const builtInDesign = (def: ReportDef) => {
    if (!def.jasper) return null;
    let x = builtIns.get(def.jasper);
    if (x === undefined) {
        x = fs.readFileSync(path.join(DESIGN_DIR, def.jasper), 'utf8');
        builtIns.set(def.jasper, x);
    }
    return x;
};

// ─── Filters ─────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = z.uuid();
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** The filters as given, with defaults filled in and each one checked. */
const resolveFilters = async (def: ReportDef, raw: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    let year: Awaited<ReturnType<typeof currentYear>> | undefined;
    const theYear = async () => (year === undefined ? (year = await currentYear()) : year);
    for (const f of def.filters) {
        let v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : '';
        if (!v && f.default) {
            if (f.type === 'date') {
                const t = today();
                v = f.default === 'today' ? t : f.default === 'monthStart' ? `${t.slice(0, 8)}01` : f.default === 'yearStart' ? `${t.slice(0, 5)}01-01` : f.default === 'sessionStart' ? ((await theYear())?.startDate.toISOString().slice(0, 10) ?? `${t.slice(0, 8)}01`) : f.default === 'sessionEnd' ? ((await theYear())?.endDate.toISOString().slice(0, 10) ?? t) : f.default;
            } else if (f.type === 'year' && f.default === 'current') v = (await theYear())?.id ?? '';
            else v = f.default;
        }
        if (!v) {
            if (f.required) throw badRequest(`Choose ${f.label.toLowerCase()}`, [{ field: f.key, message: 'is required' }]);
            continue;
        }
        if (f.type === 'date' && !ISO_DATE.test(v)) throw badRequest(`${f.label}: not a date`, [{ field: f.key, message: 'must be a date' }]);
        if ((f.type === 'year' || f.type === 'class' || f.type === 'section' || f.type === 'exam') && !UUID.safeParse(v).success) throw badRequest(`${f.label}: not valid`, [{ field: f.key, message: 'is not valid' }]);
        if (f.type === 'select' && f.options && !f.options.some((o) => o.value === v)) throw badRequest(`${f.label}: choose from the list`, [{ field: f.key, message: 'is not one of the choices' }]);
        if ((f.type === 'text' || f.type === 'master') && v.length > 100) throw badRequest(`${f.label}: too long`, [{ field: f.key, message: 'is too long' }]);
        out[f.key] = v;
    }
    return out;
};

// ─── Engine: which design makes a school's files ─────────────────────────────

const settingOf = async (key: string): Promise<Engine> => ((await db.reportSetting.findFirst({ where: { reportKey: key } }))?.engine as Engine | undefined) ?? 'auto';

/** The Jasper design this school uses for the report (its own version in use, else the built-in one), or null for the built-in table. */
const designInUse = async (def: ReportDef) => {
    const engine = await settingOf(def.key);
    if (engine === 'builtin') return null;
    const own = await db.reportDesign.findFirst({ where: { reportKey: def.key, isActive: true }, select: { jrxml: true, version: true } });
    if (own) return { jrxml: own.jrxml, label: `Jasper · the school’s version ${own.version}` };
    const built = builtInDesign(def);
    return built ? { jrxml: built, label: 'Jasper · built-in design' } : null;
};

// ─── The library ─────────────────────────────────────────────────────────────

export const listReports = async (userId: string) => {
    const a = await access(userId);
    const defs = listReportDefs().filter((d) => mayRun(d, a.permissions));
    const custom = await visibleCustomReports(userId);
    const [own, settings] = await Promise.all([
        db.reportDesign.findMany({ where: { isActive: true }, select: { reportKey: true, version: true } }),
        db.reportSetting.findMany({ select: { reportKey: true, engine: true } }),
    ]);
    return {
        canDesign: !!a.permissions['report.design'],
        canBuild: !!a.permissions['report.build'],
        reports: [...defs.map((d) => ({ ...d, custom: false })), ...custom.map((c) => ({ ...c, jasper: undefined as string | undefined, custom: true }))]
            .map((d) => {
                const engine = (settings.find((s) => s.reportKey === d.key)?.engine as Engine | undefined) ?? 'auto';
                const version = own.find((o) => o.reportKey === d.key)?.version;
                return {
                    key: d.key,
                    category: d.category,
                    label: d.label,
                    description: d.description,
                    engine: engine === 'builtin' || (!version && !d.jasper) ? 'builtin' : 'jasper',
                    customVersion: version ?? null,
                    custom: d.custom,
                };
            })
            .sort((x, y) => categoryRank(x.category) - categoryRank(y.category) || x.category.localeCompare(y.category)),
    };
};

export const getReport = async (key: string, userId: string) => {
    const { def, canDesign } = await defFor(key, userId);
    const design = await designInUse(def);
    const filters = await Promise.all(
        def.filters.map(async (f) => ({ ...f, value: (await resolveFilters({ ...def, filters: [{ ...f, required: false }] }, {}))[f.key] ?? '' }))
    );
    const a = await access(userId);
    return {
        key: def.key,
        category: def.category,
        label: def.label,
        description: def.description,
        orientation: def.orientation,
        filters,
        columns: def.columns,
        engine: design ? design.label : 'Built-in table layout',
        canDesign,
        canBuild: !!a.permissions['report.build'],
        customId: def.key.startsWith(CUSTOM_PREFIX) ? def.key.slice(CUSTOM_PREFIX.length) : null,
        hasBuiltInDesign: !!def.jasper,
    };
};

const totalsOf = (columns: ReportColumn[], rows: Record<string, unknown>[]) =>
    Object.fromEntries(columns.filter((c) => c.total).map((c) => [c.key, rows.reduce((a, r) => a + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0)]));

const gather = async (def: ReportDef, raw: Record<string, unknown>, userId: string) => {
    const filters = await resolveFilters(def, raw);
    const result = await def.run(filters, { userId });
    return { filters, result };
};

/** The report on screen (rows, totals). */
export const runReport = async (key: string, raw: Record<string, unknown>, userId: string) => {
    const { def } = await defFor(key, userId);
    const { result } = await gather(def, raw, userId);
    return {
        subtitle: result.subtitle ?? '',
        groupedBy: result.groupedBy ?? null,
        columns: def.columns,
        rows: result.rows.slice(0, SCREEN_ROWS),
        count: result.rows.length,
        truncated: result.rows.length > SCREEN_ROWS,
        totals: totalsOf(def.columns, result.rows),
    };
};

// ─── For custom alerts ───────────────────────────────────────────────────────

/** Reports whose rows are people (they can drive custom alerts) that this person may run. */
export const alertReports = async (userId: string) => {
    const a = await access(userId);
    return listReportDefs()
        .filter((d) => d.about && mayRun(d, a.permissions))
        .sort((x, y) => categoryRank(x.category) - categoryRank(y.category) || x.label.localeCompare(y.label))
        .map((d) => ({ key: d.key, label: d.label, category: d.category, description: d.description, about: d.about!, columns: d.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })) }));
};

/** A report's rows for a custom alert, run as the person who made it (so it never reaches more than they may see). */
export const rowsForAlert = async (key: string, raw: Record<string, unknown>, userId: string) => {
    const { def } = await defFor(key, userId);
    if (!def.about) throw badRequest('This report can’t be used for alerts');
    const { result } = await gather(def, raw, userId);
    return { def, rows: result.rows, subtitle: result.subtitle ?? '' };
};

// ─── Files ───────────────────────────────────────────────────────────────────

const MIME: Record<ExportFormat, string> = {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const printedAt = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

/** The letterhead and title, as Jasper parameters. */
const parametersFor = async (def: ReportDef, result: ReportResult, userId: string) => {
    const [school, user] = await Promise.all([schoolContext(), db.user.findUnique({ where: { id: userId }, select: { displayName: true } })]);
    return {
        SCHOOL_NAME: school.name,
        SCHOOL_ADDRESS: school.address,
        SCHOOL_CONTACT: [school.phone, school.email, school.website].filter(Boolean).join(' · '),
        SCHOOL_CODES: [school.affiliationNo && `Affiliation no. ${school.affiliationNo}`, school.udiseCode && `UDISE ${school.udiseCode}`].filter(Boolean).join(' · '),
        SCHOOL_LOGO: school.logo,
        REPORT_TITLE: def.label,
        REPORT_SUBTITLE: result.subtitle ?? '',
        GROUPED_BY: result.groupedBy ?? '',
        PRINTED_BY: user?.displayName ?? '',
        PRINTED_AT: printedAt(),
    };
};

const fileName = (def: ReportDef, format: ExportFormat) => `${def.label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${today()}.${format}`;

/**
 * The report as a file. With a Jasper design it is made by the report service; if that isn't running,
 * PDF and Excel come from the built-in layout instead (and `note` says so).
 */
export const exportReport = async (key: string, raw: Record<string, unknown>, format: ExportFormat, userId: string, override?: { jrxml: string; label: string }) => {
    const { def } = await defFor(key, userId);
    const { result } = await gather(def, raw, userId);
    const design = override ?? (await designInUse(def));
    const params = await parametersFor(def, result, userId);
    let unreachable = '';
    if (design) {
        try {
            const { file } = await jasperRender({ design: design.jrxml, format, rows: result.rows, params });
            return { file, contentType: MIME[format], filename: fileName(def, format), engine: design.label, note: null as string | null };
        } catch (err) {
            if (!(err instanceof JasperUnavailableError) || override) throw err;
            unreachable = err.reason;
            if (format === 'docx') throw badRequest('Word files are made by the report service (Jasper), which is not running. Choose PDF or Excel, or start the report service.');
            logger.warn('Report service not running: built-in layout used', { report: def.key });
        }
    } else if (format === 'docx') throw badRequest('Word files need a Jasper design for this report. Choose PDF or Excel.');
    const note = design ? `The report service (Jasper) is not running, so the built-in layout was used.${unreachable ? ` (${unreachable})` : ''}` : null;
    const file = format === 'pdf' ? await builtInPdf(def, result, params) : await builtInExcel(def, result, params);
    return { file, contentType: MIME[format], filename: fileName(def, format), engine: 'Built-in table layout', note };
};

// ─── The built-in layout (no Jasper needed) ──────────────────────────────────

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const indian = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const showDate = (v: unknown) => {
    if (typeof v !== 'string' || !v) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const cell = (c: ReportColumn, v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'money') return typeof v === 'number' ? `₹${indian(v)}` : esc(v);
    if (c.type === 'number') return typeof v === 'number' ? indian(v) : esc(v);
    if (c.type === 'date') return esc(showDate(v));
    return esc(v);
};

/** Rows split into their groups (one group with no heading when the report isn't grouped). */
const groupsOf = (result: ReportResult) => {
    const groups: { label: string | null; rows: Record<string, unknown>[] }[] = [];
    for (const r of result.rows) {
        const label = result.groupedBy ? String(r.groupLabel ?? '—') : null;
        const last = groups[groups.length - 1];
        if (last && last.label === label) last.rows.push(r);
        else groups.push({ label, rows: [r] });
    }
    return groups;
};

const builtInPdf = async (def: ReportDef, result: ReportResult, p: Awaited<ReturnType<typeof parametersFor>>) => {
    const cols = def.columns;
    const weight = cols.reduce((a, c) => a + (c.width ?? 1), 0);
    const num = (c: ReportColumn) => c.type === 'money' || c.type === 'number';
    const totalsRow = (label: string, rows: Record<string, unknown>[], cls: string) => {
        const t = totalsOf(cols, rows);
        const firstTotal = cols.findIndex((c) => c.total);
        if (firstTotal < 0) return `<tr class="${cls}"><td colspan="${cols.length}">${esc(label)} · ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}</td></tr>`;
        return `<tr class="${cls}"><td colspan="${Math.max(1, firstTotal)}">${esc(label)} · ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}</td>${cols
            .slice(Math.max(1, firstTotal))
            .map((c) => `<td class="${num(c) ? 'r' : ''}">${c.total ? cell(c, t[c.key]) : ''}</td>`)
            .join('')}</tr>`;
    };
    const groups = groupsOf(result);
    const body = groups
        .map((g) => {
            const head = g.label !== null ? `<tr class="gh"><td colspan="${cols.length}">${esc(result.groupedBy)}: ${esc(g.label)}</td></tr>` : '';
            const rows = g.rows.map((r) => `<tr>${cols.map((c) => `<td class="${num(c) ? 'r' : ''}">${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('');
            return head + rows + (g.label !== null && groups.length > 1 ? totalsRow(`Total for ${g.label}`, g.rows, 'gt') : '');
        })
        .join('');
    const html = `
<header>
  ${p.SCHOOL_LOGO ? `<img class="logo" src="${p.SCHOOL_LOGO}" alt="">` : ''}
  <div><h1>${esc(p.SCHOOL_NAME)}</h1><p>${esc(p.SCHOOL_ADDRESS)}</p>${p.SCHOOL_CONTACT ? `<p>${esc(p.SCHOOL_CONTACT)}</p>` : ''}</div>
</header>
<h2>${esc(def.label)}</h2>
${p.REPORT_SUBTITLE ? `<p class="sub">${esc(p.REPORT_SUBTITLE)}</p>` : ''}
<table>
  <colgroup>${cols.map((c) => `<col style="width:${(((c.width ?? 1) / weight) * 100).toFixed(2)}%">`).join('')}</colgroup>
  <thead><tr>${cols.map((c) => `<th class="${num(c) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${body || `<tr><td colspan="${cols.length}" class="none">Nothing to show for these filters.</td></tr>`}</tbody>
  ${result.rows.length ? `<tfoot>${totalsRow('Grand total', result.rows, 'tot')}</tfoot>` : ''}
</table>`;
    const css = `
header { display: flex; align-items: center; gap: 10px; border-bottom: 1.5px solid #1a365d; padding-bottom: 6px; margin-bottom: 8px; }
header .logo { height: 42px; width: auto; }
header h1 { font-size: 15px; margin: 0; color: #1a365d; text-transform: uppercase; letter-spacing: .3px; }
header p { margin: 1px 0 0; font-size: 9px; color: #444; }
h2 { font-size: 13px; margin: 6px 0 2px; color: #111; }
.sub { margin: 0 0 8px; font-size: 9.5px; color: #555; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9px; }
thead { display: table-header-group; }
tfoot { display: table-row-group; }
th { text-align: left; background: #1a365d; color: #fff; padding: 4px 5px; font-weight: 600; }
td { padding: 3px 5px; border-bottom: 0.5px solid #ddd; overflow-wrap: anywhere; }
tr { break-inside: avoid; }
.r { text-align: right; }
.gh td { background: #eef2f7; font-weight: 700; color: #1a365d; padding-top: 5px; border-bottom: 1px solid #c9d3e0; }
.gt td { font-weight: 700; border-bottom: 1px solid #999; background: #fafafa; }
.tot td { font-weight: 800; border-top: 1.5px solid #1a365d; border-bottom: 1.5px solid #1a365d; font-size: 9.5px; }
.none { text-align: center; padding: 20px; color: #777; }`;
    const paper = { size: 'A4' as const, orientation: def.orientation, margin: 10 };
    return htmlToPdf(pageHtml(html, css, paper), paper, `Printed by ${p.PRINTED_BY} on ${p.PRINTED_AT} | Page {page} of {pages}`);
};

/** The report as Excel, in the same look as every export (core/excel/styled). */
const builtInExcel = async (def: ReportDef, result: ReportResult, p: Awaited<ReturnType<typeof parametersFor>>) => {
    const columns = def.columns.map((c) => ({ header: c.label, width: Math.max(10, Math.round((c.width ?? 1) * 12)), type: c.type, total: c.total, value: (r: Record<string, unknown>) => r[c.key] as string | number | null }));
    const groups = result.groupedBy ? groupsOf(result).map((g) => ({ label: g.label ?? '—', rows: g.rows })) : undefined;
    return buildStyledWorkbook({ title: def.label, subtitle: p.REPORT_SUBTITLE || undefined, columns, rows: result.rows, groups, groupedBy: result.groupedBy });
};

// ─── Designs (super admin: report.design) ────────────────────────────────────

/** Fields and parameters a design for this report may use. */
const available = (def: ReportDef) => ({
    fields: [...def.columns, ...GROUP_FIELDS].map((c) => ({ name: c.key, label: c.label, type: c.type === 'money' || c.type === 'number' ? 'java.math.BigDecimal' : c.type === 'date' ? 'java.util.Date' : 'java.lang.String' })),
    parameters: COMMON_PARAMETERS,
});

export const getDesigns = async (key: string, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    const [versions, engine, service] = await Promise.all([
        db.reportDesign.findMany({ where: { reportKey: def.key }, orderBy: { version: 'desc' }, select: { id: true, version: true, fileName: true, note: true, isActive: true, createdAt: true, createdBy: true } }),
        settingOf(def.key),
        jasperHealth(),
    ]);
    const users = new Map((await db.user.findMany({ where: { id: { in: versions.map((v) => v.createdBy).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    return {
        engine,
        hasBuiltInDesign: !!def.jasper,
        service,
        versions: versions.map(({ createdBy, ...v }) => ({ ...v, uploadedBy: createdBy ? (users.get(createdBy) ?? null) : null })),
        ...available(def),
    };
};

export const designUploadSchema = z.strictObject({
    fileName: z.string().trim().min(1).max(120),
    note: z.string().trim().max(300).optional(),
    jrxml: z.string().min(50, 'is not a Jasper design').max(2_000_000, 'is too big (2 MB at most)'),
});

/** Checks a design with the report service and keeps it as a new version (not in use until chosen). */
export const uploadDesign = async (key: string, input: z.infer<typeof designUploadSchema>, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    if (!/<jasperReport[\s>]/.test(input.jrxml)) throw badRequest('This is not a Jasper design (.jrxml)', [{ field: 'jrxml', message: 'has no <jasperReport>' }]);
    let info;
    try {
        info = await jasperInspect(input.jrxml);
    } catch (err) {
        if (err instanceof JasperUnavailableError) throw badRequest('Start the report service (Jasper) to check and upload a design.');
        throw err;
    }
    const known = new Set(available(def).fields.map((f) => f.name));
    const unknown = info.fields.filter((f) => !known.has(f.name)).map((f) => f.name);
    if (unknown.length) throw badRequest(`The design uses fields this report doesn’t have: ${unknown.join(', ')}`, [{ field: 'design', message: `Fields of this report: ${[...known].join(', ')}` }]);
    const knownParams = new Set(COMMON_PARAMETERS.map((p) => p.name));
    const warnings = info.parameters.filter((p) => !knownParams.has(p.name)).map((p) => `Parameter ${p.name} is not filled by the ERP (it keeps its default value).`);
    const created = await withTransaction(async (tx) => {
        const last = await tx.reportDesign.findFirst({ where: { reportKey: def.key }, orderBy: { version: 'desc' }, select: { version: true } });
        return tx.reportDesign.create({
            data: { tenantId: getTenantId()!, reportKey: def.key, version: (last?.version ?? 0) + 1, fileName: input.fileName, note: input.note || null, jrxml: input.jrxml, info: info as unknown as Prisma.InputJsonValue },
            select: { id: true, version: true },
        });
    });
    await recordAudit({ action: 'report_design_uploaded', entity: 'report_design', entityId: created.id, changes: { report: def.key, version: created.version, file: input.fileName } });
    return { ...created, warnings };
};

const versionOf = async (key: string, id: string) => {
    if (!UUID.safeParse(id).success) throw notFound('No such version');
    const v = await db.reportDesign.findFirst({ where: { id, reportKey: key } });
    if (!v) throw notFound('No such version');
    return v;
};

/** Uses this version for the school's files (and switches the engine to automatic, i.e. Jasper). */
export const activateDesign = async (key: string, id: string, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    const v = await versionOf(def.key, id);
    await withTransaction(async (tx) => {
        await tx.reportDesign.updateMany({ where: { reportKey: def.key, isActive: true }, data: { isActive: false } });
        await tx.reportDesign.update({ where: { id: v.id }, data: { isActive: true } });
    });
    await recordAudit({ action: 'report_design_activated', entity: 'report_design', entityId: v.id, changes: { report: def.key, version: v.version } });
    return getDesigns(key, userId);
};

/** Back to the built-in design (the school's versions are kept). */
export const resetDesign = async (key: string, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    await db.reportDesign.updateMany({ where: { reportKey: def.key, isActive: true }, data: { isActive: false } });
    await recordAudit({ action: 'report_design_reset', entity: 'report_design', changes: { report: def.key } });
    return getDesigns(key, userId);
};

export const deleteDesign = async (key: string, id: string, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    const v = await versionOf(def.key, id);
    if (v.isActive) throw badRequest('This version is in use. Choose another one (or the built-in design) first.');
    await db.reportDesign.delete({ where: { id: v.id } });
    await recordAudit({ action: 'report_design_deleted', entity: 'report_design', entityId: v.id, changes: { report: def.key, version: v.version } });
    return getDesigns(key, userId);
};

export const engineSchema = z.strictObject({ engine: z.enum(['auto', 'jasper', 'builtin']) });

export const setEngine = async (key: string, engine: Engine, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    const tenantId = getTenantId()!;
    await db.reportSetting.upsert({ where: { tenantId_reportKey: { tenantId, reportKey: def.key } }, create: { tenantId, reportKey: def.key, engine }, update: { engine } });
    await recordAudit({ action: 'report_engine_set', entity: 'report_setting', changes: { report: def.key, engine } });
    return getDesigns(key, userId);
};

/** A design to download: a version, or the built-in one ('builtin'). */
export const downloadDesign = async (key: string, id: string, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    if (id === 'builtin') {
        const x = builtInDesign(def);
        if (!x) throw notFound('This report has no built-in Jasper design');
        return { jrxml: x, fileName: def.jasper! };
    }
    const v = await versionOf(def.key, id);
    return { jrxml: v.jrxml, fileName: v.fileName };
};

/** The report made with one version (or the built-in design) without putting it in use. */
export const previewDesign = async (key: string, id: string, raw: Record<string, unknown>, format: ExportFormat, userId: string) => {
    const d = await downloadDesign(key, id, userId);
    return exportReport(key, raw, format, userId, { jrxml: d.jrxml, label: id === 'builtin' ? 'Jasper · built-in design' : 'Jasper · preview' });
};

/**
 * Data to design with in Jaspersoft Studio (a JSON data adapter on this file, query "rows"): the rows
 * for the filters and the parameters the ERP fills.
 */
export const sampleData = async (key: string, raw: Record<string, unknown>, userId: string) => {
    const { def } = await defFor(key, userId);
    await needDesign(userId);
    const { result } = await gather(def, raw, userId);
    const params = await parametersFor(def, result, userId);
    return { report: def.key, rows: result.rows.slice(0, 500), params: { ...params, SCHOOL_LOGO: params.SCHOOL_LOGO ? '(the logo, as an image)' : null }, fields: available(def).fields };
};

// ─── Report Builder ──────────────────────────────────────────────────────────

/** A Jasper design made from the report's columns, to start the school's own from. */
export const generatedDesign = async (key: string, userId: string) => {
    const { def } = await defFor(key, userId);
    const a = await access(userId);
    if (!a.permissions['report.design'] && !a.permissions['report.build']) throw forbidden();
    return { jrxml: generateJrxml(def), fileName: `${def.label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'report'}.jrxml` };
};

/** A definition being built, run with its defaults: the first rows, the totals and the filters it will ask. */
export const previewDefinition = async (d: Definition, userId: string) => {
    if (!(await access(userId)).permissions['report.build']) throw forbidden();
    await checkDefinition(d, userId);
    const def = await definitionReport({ key: `${CUSTOM_PREFIX}preview`, label: 'Preview', description: '', category: 'Preview' }, d, userId);
    const filters = await resolveFilters(def, {});
    const result = await def.run(filters, { userId });
    return {
        subtitle: result.subtitle ?? '',
        groupedBy: result.groupedBy ?? null,
        columns: def.columns,
        rows: result.rows.slice(0, 100),
        count: result.rows.length,
        truncated: result.rows.length > 100,
        totals: totalsOf(def.columns, result.rows),
        asks: def.filters.map((f) => ({ key: f.key, label: f.label, type: f.type })),
    };
};
