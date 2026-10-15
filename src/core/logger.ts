import { getContext } from './context';

/**
 * Minimal structured logger. Development: readable lines. Production: one JSON object per line.
 * Never pass passwords, tokens or secrets in `fields`.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const json = process.env.NODE_ENV === 'production';
const quiet = process.env.NODE_ENV === 'test';

const write = (level: Level, message: string, fields?: Fields) => {
    if (quiet && level !== 'error') return;
    const ctx = getContext();
    const base = { requestId: ctx?.requestId, userId: ctx?.user?.id, ...fields };

    if (json) {
        const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...base });
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
