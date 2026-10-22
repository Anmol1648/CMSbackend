import type { CookieOptions, Request, Response } from 'express';

/**
 * The refresh token travels only in an httpOnly cookie scoped to /api/auth, so page scripts can't
 * read it and it isn't sent with ordinary API calls.
 */
export const REFRESH_COOKIE = 'cms_rt';

/**
 * Page and API on different hosts (e.g. the app on Vercel, the API on Render) are different sites:
 * browsers send a SameSite=Lax cookie only to the same site, so the session could never be renewed.
 * Then the cookie is SameSite=None (which must be Secure); on one host it stays Lax.
 */
const crossSite = (req: Request | undefined) => {
    const origin = req?.headers.origin;
    if (!origin || !req) return false;
    try {
        return new URL(origin).hostname !== req.hostname;
    } catch {
        return false;
    }
};

const options = (req: Request | undefined, expires?: Date): CookieOptions => {
    const cross = crossSite(req);
    return {
        httpOnly: true,
        secure: cross || process.env.NODE_ENV === 'production',
        sameSite: cross ? 'none' : 'lax',
        path: '/api/auth',
        ...(expires ? { expires } : {}),
    };
};

export const setRefreshCookie = (res: Response, token: string, expires: Date) => res.cookie(REFRESH_COOKIE, token, options(res.req, expires));

export const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, options(res.req));

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
