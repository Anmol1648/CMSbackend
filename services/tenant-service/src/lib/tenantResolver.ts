import { Request } from 'express';
import jwt from 'jsonwebtoken';

interface DecodedToken {
  tenantId?: string;
  [key: string]: any;
}

export function resolveTenantId(req: Request): string | null {
  // 1. Resolve from JWT (highest priority)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      // Decode without verifying signature just to extract tenantId if it's there
      // Note: Actual verification should happen in an auth middleware
      const decoded = jwt.decode(token) as DecodedToken;
      if (decoded && decoded.tenantId) {
        return decoded.tenantId;
      }
    } catch (e) {
      console.warn('Failed to decode JWT for tenant resolution', e);
    }
  }

  // 2. Resolve from Header (e.g. x-tenant-id)
  const tenantHeader = req.headers['x-tenant-id'];
  if (tenantHeader && typeof tenantHeader === 'string') {
    return tenantHeader;
  }

  // 3. Resolve from subdomain
  // Example: college-a.cms.com -> college-a
  const host = req.headers.host;
  if (host) {
    const parts = host.split('.');
    // Assuming root domain has 2 parts like cms.com, or localhost
    // We take the first part if there are more than 2 parts (e.g., college-a.cms.com -> parts length 3)
    if (parts.length > 2) {
      // It's a simplistic approach, adjust depending on base domains length
      return parts[0];
    } else if (parts.length === 2 && parts[0] !== 'localhost') {
        // e.g. college-a.localhost
        return parts[0];
    }
  }

  return null;
}
