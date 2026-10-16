import type { ImportJob } from '@prisma/client';
import { db } from '../../core/db';
import { getContext, getTenantId } from '../../core/context';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { recordAudit } from '../../core/audit';
import { getSetting } from '../../core/settings';
import { readFile, saveUpload, UPLOADS } from '../../core/files';
import { buildTemplate, buildWorkbook, ImportColumn, parseRows, ParsedRow } from '../../core/excel';
import { getUserAccess } from '../rbac/access.service';

/**
 * Excel imports for any module. A module registers what it imports (columns, checks, how to save
 * one row); everything else — template, checking, preview, importing the good rows, error report,
 * history — is shared.
 */

export interface ImportDefinition<Ctx = unknown> {
    kind: string;
    label: string;
    /** Needed to download the template and to import. */
    permission: string;
    /** Columns, built per request (choices can come from the school's data, e.g. role names). */
    columns: () => Promise<ImportColumn[]>;
    /** Loads what the checks need (existing usernames, roles…). */
    prepare: (actorUserId: string) => Promise<Ctx>;
    /** Adds problems that need the database (already taken, not allowed…) to row.issues. */
    check: (row: ParsedRow, ctx: Ctx) => void | Promise<void>;
    /** Saves one valid row; returns what to show in the result (e.g. username and one-time password). */
    importRow: (row: ParsedRow, ctx: Ctx, actorUserId: string) => Promise<Record<string, string>>;
}

const definitions = new Map<string, ImportDefinition<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any

export const registerImport = <Ctx>(def: ImportDefinition<Ctx>) => {
    if (definitions.has(def.kind)) throw new Error(`Import "${def.kind}" is registered twice`);
    definitions.set(def.kind, def);
};

const definition = (kind: string) => {
    const def = definitions.get(kind);
    if (!def) throw notFound('Unknown import');
    return def;
};

const assertAllowed = async (def: ImportDefinition<unknown>, userId: string) => {
    if (!(await getUserAccess(userId)).permissions[def.permission]) throw forbidden('You do not have permission to import these records');
};

export const importTemplate = async (kind: string, userId: string) => {
    const def = definition(kind);
    await assertAllowed(def, userId);
    const max = await getSetting(UPLOADS.maxImportRows);
    return { fileName: `${def.kind}-import-template.xlsx`, data: await buildTemplate(await def.columns(), `${def.label}: import template`, max) };
};

/** What goes in each column, with allowed values and their meaning (shown on the import screen). */
export const importColumns = async (kind: string, userId: string) => {
    const def = definition(kind);
    await assertAllowed(def, userId);
    const columns = await def.columns();
    return columns.map(({ key, header, type, required, choices, choiceHelp, help, example, max }) => ({
        key,
        header,
        type,
        required: !!required,
        help: help ?? null,
        example: example || null,
        max: max ?? null,
        choices: choices?.map((value) => ({ value, help: choiceHelp?.[value] ?? null })) ?? null,
    }));
};

/** Checks every row (and the whole file) without saving anything. */
const checkFile = async (def: ImportDefinition<unknown>, data: Buffer, userId: string) => {
    const max = await getSetting(UPLOADS.maxImportRows);
    const parsed = await parseRows(await def.columns(), data, max);
    if (parsed.problems.length) return { ...parsed, ctx: null };
    const ctx = await def.prepare(userId);
    for (const row of parsed.rows) if (!row.issues.length) await def.check(row, ctx);
    return { ...parsed, ctx };
};

const issuesOf = (rows: ParsedRow[]) => rows.flatMap((r) => r.issues.map((i) => ({ row: r.row, field: i.field, message: i.message })));

const preview = (rows: ParsedRow[]) =>
    rows.slice(0, 500).map((r) => ({
        row: r.row,
        ok: r.issues.length === 0,
        values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.join(', ') : v])),
        issues: r.issues,
    }));

export const validateImport = async (kind: string, upload: { data: Buffer; originalName: string }, userId: string) => {
    const def = definition(kind);
    await assertAllowed(def, userId);
    const file = await saveUpload({ data: upload.data, originalName: upload.originalName, purpose: 'import', allowed: ['xlsx'] });
    const result = await checkFile(def, upload.data, userId);
    const valid = result.rows.filter((r) => !r.issues.length).length;
    const job = await db.importJob.create({
        data: {
            tenantId: getTenantId()!,
            kind,
            status: result.problems.length ? 'failed' : 'validated',
            fileId: file.id,
            totalRows: result.rows.length,
            validRows: result.problems.length ? 0 : valid,
            errorRows: issuesOf(result.rows) as object,
            options: { problems: result.problems, fileName: upload.originalName } as object,
            createdBy: userId,
        },
    });
    return { job: presentJob(job), problems: result.problems, rows: preview(result.rows), columns: (await def.columns()).map((c) => ({ key: c.key, header: c.header })) };
};

/** Imports the rows that pass the checks now (they are checked again: data may have changed). */
export const runImport = async (jobId: string, userId: string) => {
    const job = await db.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Import not found');
    const def = definition(job.kind);
    await assertAllowed(def, userId);
    if (job.status !== 'validated') throw conflict(job.status === 'done' ? 'This file has already been imported' : 'This import can’t be run; upload the file again');
    if (!job.fileId) throw badRequest('The uploaded file is missing; upload it again');

    const claimed = await db.importJob.updateMany({ where: { id: jobId, status: 'validated' }, data: { status: 'importing' } });
    if (claimed.count !== 1) throw conflict('This import is already running');

    const { data } = await readFile(job.fileId);
    const result = await checkFile(def, data, userId);
    const results: { row: number; values: Record<string, string> }[] = [];
    const failures = issuesOf(result.rows);
    if (!result.problems.length) {
        for (const row of result.rows.filter((r) => !r.issues.length)) {
            try {
                results.push({ row: row.row, values: await def.importRow(row, result.ctx, userId) });
            } catch (err) {
                failures.push({ row: row.row, field: '', message: (err as Error).message || 'could not be saved' });
            }
        }
    }
    const done = await db.importJob.update({
        where: { id: jobId },
        data: { status: result.problems.length ? 'failed' : 'done', importedRows: results.length, errorRows: failures as object, finishedAt: new Date() },
    });
    await recordAudit({ action: 'import', entity: job.kind, entityId: jobId, changes: { file: (job.options as { fileName?: string } | null)?.fileName ?? null, imported: results.length, skipped: failures.length } });
    return { job: presentJob(done), results, problems: result.problems };
};

/** The problems of an import as an Excel file (row, column, problem). */
export const importErrorReport = async (jobId: string, userId: string) => {
    const job = await db.importJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('Import not found');
    await assertAllowed(definition(job.kind), userId);
    const issues = (job.errorRows as { row: number; field: string; message: string }[] | null) ?? [];
    const problems = ((job.options as { problems?: string[] } | null)?.problems ?? []).map((p) => ({ row: 0, field: '', message: p }));
    const data = await buildWorkbook(
        'Problems',
        [
            { header: 'Row', width: 8, value: (r) => (r.row || '') as number | string },
            { header: 'Column', width: 24, value: (r) => r.field },
            { header: 'Problem', width: 70, value: (r) => r.message },
        ],
        [...problems, ...issues]
    );
    return { fileName: `${job.kind}-import-problems.xlsx`, data };
};

export const listImportJobs = async (kind: string, userId: string) => {
    await assertAllowed(definition(kind), userId);
    const jobs = await db.importJob.findMany({ where: { kind }, orderBy: { createdAt: 'desc' }, take: 20 });
    return jobs.map(presentJob);
};

const presentJob = (j: ImportJob) => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    fileName: (j.options as { fileName?: string } | null)?.fileName ?? null,
    totalRows: j.totalRows,
    validRows: j.validRows,
    importedRows: j.importedRows,
    problemCount: Array.isArray(j.errorRows) ? j.errorRows.length : 0,
    createdAt: j.createdAt,
    createdBy: j.createdBy,
    finishedAt: j.finishedAt,
    byMe: j.createdBy === getContext()?.user?.id,
});
