import type { CookieOptions, Request, Response } from 'express';

/**
 * The refresh token travels only in an httpOnly cookie scoped to /api/auth, so page scripts can't
 * read it and it isn't sent with ordinary API calls.
 */
export const REFRESH_COOKIE = 'cms_rt';

const options = (expires?: Date): CookieOptions => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    ...(expires ? { expires } : {}),
});

export const setRefreshCookie = (res: Response, token: string, expires: Date) => res.cookie(REFRESH_COOKIE, token, options(expires));

export const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, options());

export const readRefreshCookie = (req: Request): string | undefined => {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === REFRESH_COOKIE) {
            try {
                return decodeURIComponent(part.slice(eq + 1).trim());
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
};
