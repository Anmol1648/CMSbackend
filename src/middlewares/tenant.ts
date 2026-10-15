import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { setTenant } from '../core/context';
import { findTenantByCode, findTenantByDomain, TenantRef } from '../modules/tenants';

/**
 * Before sign-in, works out the school from the address of the page calling the API (the browser's
 * Origin header, else the Host) matched against tenants.domain, falling back to DEFAULT_TENANT_CODE.
 * After sign-in the school always comes from the access token (authenticate); a token for another
 * school than a matched domain is rejected there.
 */

export interface HostTenant extends TenantRef {
    /** 'domain' = the address matched this school; 'default' = DEFAULT_TENANT_CODE fallback. */
    source: 'domain' | 'default';
}

const candidateHosts = (req: Request): string[] => {
    const hosts: string[] = [];
    const origin = req.header('origin');
    if (origin) {
        try {
            hosts.push(new URL(origin).hostname.toLowerCase());
        } catch {
            // ignore malformed Origin
        }
    }
    if (req.hostname) hosts.push(req.hostname.toLowerCase());
    return [...new Set(hosts)];
};

export const resolveRequestTenant = async (req: Request): Promise<HostTenant | null> => {
    for (const host of candidateHosts(req)) {
        const tenant = await findTenantByDomain(host);
        if (tenant) return { ...tenant, source: 'domain' };
    }
    if (env.DEFAULT_TENANT_CODE) {
        const tenant = await findTenantByCode(env.DEFAULT_TENANT_CODE);
        if (tenant) return { ...tenant, source: 'default' };
    }
    return null;
};

declare global {
    namespace Express {
        interface Request {
            /** School resolved from the calling address (before sign-in), if any. */
            hostTenant?: HostTenant | null;
        }
    }
}

export const tenantFromHost = async (req: Request, _res: Response, next: NextFunction) => {
    try {
        req.hostTenant = await resolveRequestTenant(req);
        if (req.hostTenant?.status === 'active') setTenant(req.hostTenant.id);
        next();
    } catch (err) {
        next(err);
    }
};
