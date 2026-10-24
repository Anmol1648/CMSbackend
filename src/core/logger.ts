import { getContext } from './context';

/**
 * Minimal structured logger. Development: readable lines. Production: one JSON object per line.
 * Never pass passwords, tokens or secrets in `fields`.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const json = process.env.NODE_ENV === 'production';
const quiet = process.env.NODE_ENV === 'test';

// Connection strings (with their passwords) never reach the log.
const scrub = (s: string) => s.replace(/(postgres(ql)?|redis(s)?|mysql|mongodb(\+srv)?):\/\/\S+/gi, '$1://[hidden]');
/** An Error as plain fields (JSON.stringify of an Error keeps only `name`). */
const plain = (e: Error & { code?: unknown; errorCode?: unknown }) => ({ name: e.name, message: scrub(e.message ?? ''), code: e.code ?? e.errorCode, stack: e.stack ? scrub(e.stack).split('\n').slice(0, 6).join('\n') : undefined });

const write = (level: Level, message: string, fields?: Fields) => {
    if (quiet && level !== 'error') return;
    const ctx = getContext();
    const base = { requestId: ctx?.requestId, userId: ctx?.user?.id, ...fields };

    if (json) {
        const out = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v instanceof Error ? plain(v) : v]));
        const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...out });
        (level === 'error' ? console.error : console.log)(line);
        return;
    }

    const extras = Object.entries(base)
        .filter(([, v]) => v !== undefined && !((v as unknown) instanceof Error))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
    const err = Object.values(fields ?? {}).find((v) => v instanceof Error) as Error | undefined;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extras ? '  ' + extras : ''}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    if (err?.stack) console.error(err.stack);
};

export const logger = {
    debug: (message: string, fields?: Fields) => write('debug', message, fields),
    info: (message: string, fields?: Fields) => write('info', message, fields),
    warn: (message: string, fields?: Fields) => write('warn', message, fields),
    error: (message: string, fields?: Fields) => write('error', message, fields),
};
