import { env } from '../../config/env';
import { AppError, badRequest } from '../errors';
import { ErrorCode } from '../index';
import { logger } from '../logger';

/**
 * The JasperReports renderer (jasper-service, a separate Java program). It gets a design (.jrxml) and
 * the rows the person may see, and returns the file; it never reads the database itself.
 */

export type JasperFormat = 'pdf' | 'xlsx' | 'docx';

export interface JasperDesignInfo {
    name: string;
    pageWidth: number;
    pageHeight: number;
    orientation: 'portrait' | 'landscape' | null;
    fields: { name: string; type: string; description?: string }[];
    parameters: { name: string; type: string; description?: string }[];
}

/** The renderer isn't running (or can't be reached): callers fall back or say so. */
export class JasperUnavailableError extends AppError {
    /** Why it couldn't be reached (connection refused, bad header…), for the person fixing the setup. */
    constructor(public readonly reason = '') {
        super('The report service (Jasper) is not running', 503, ErrorCode.INTERNAL_SERVER_ERROR);
    }
}

const base = () => (env.JASPER_URL?.trim() || 'http://127.0.0.1:8090').replace(/\/+$/, '');
/** Trimmed: a space or line break pasted into the host's settings would make every request fail. */
const token = () => env.JASPER_TOKEN?.trim();

const post = (path: string, body: string, timeoutMs: number) =>
    fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
    });

const call = async (path: string, body: unknown, timeoutMs: number) => {
    let res: Response;
    const json = JSON.stringify(body);
    try {
        try {
            res = await post(path, json, timeoutMs);
        } catch (first) {
            // A proxy in front of the service (Render, a load balancer) may have closed the reused
            // connection; rendering changes nothing, so try once more on a fresh one.
            if ((first as Error).name === 'TimeoutError') throw first;
            res = await post(path, json, timeoutMs);
        }
    } catch (err) {
        if ((err as Error).name === 'TimeoutError') throw new AppError('The report took too long to make. Choose fewer records.', 504, ErrorCode.INTERNAL_SERVER_ERROR);
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const reason = [(err as Error).message, cause?.code, cause?.message].filter(Boolean).join(' · ');
        logger.warn('Report service unreachable', { url: base(), reason });
        throw new JasperUnavailableError(reason);
    }
    if (res.ok) return res;
    const problem = (await res.json().catch(() => ({}))) as { kind?: string; error?: string; detail?: string };
    if (res.status === 401) {
        logger.error('Report service refused the token (JASPER_TOKEN differs)');
        throw new AppError('The report service refused the request (check JASPER_TOKEN on both sides)', 500, ErrorCode.INTERNAL_SERVER_ERROR);
    }
    const message = problem.error ?? `The report service answered ${res.status}`;
    if (res.status >= 500) {
        logger.error('Report service failed', { status: res.status, error: message, detail: problem.detail });
        throw new AppError(message, 500, ErrorCode.INTERNAL_SERVER_ERROR);
    }
    // A mistake in the design or data that doesn't fit it: tell the person (with the place it is in).
    throw badRequest(message, problem.detail ? [{ field: problem.kind === 'design' ? 'design' : 'data', message: problem.detail }] : undefined);
};

/** Fills the design with the rows and returns the file. */
export const jasperRender = async (input: { design: string; format: JasperFormat; rows: Record<string, unknown>[]; params: Record<string, unknown> }) => {
    const res = await call('/render', input, 150_000);
    return { file: Buffer.from(await res.arrayBuffer()), pages: Number(res.headers.get('x-pages') ?? 0) };
};

/** Compiles a design and lists the fields and parameters it expects (a mistake comes back as a 400). */
export const jasperInspect = async (design: string): Promise<JasperDesignInfo> => (await (await call('/inspect', { design }, 60_000)).json()) as JasperDesignInfo;

/** Is the renderer running (and which version). */
export const jasperHealth = async (): Promise<{ running: boolean; version?: string }> => {
    try {
        // A sleeping host (e.g. Render free plan) takes ~15 s to wake: wait for it.
        const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(25_000) });
        const body = (await res.json()) as { jasperreports?: string };
        return { running: res.ok, version: body.jasperreports };
    } catch {
        return { running: false };
    }
};
