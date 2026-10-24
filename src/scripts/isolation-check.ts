import { parseArgs } from 'node:util';
import { Prisma } from '@prisma/client';
import { db } from '../core/db';
import { runAsSystem, runAsTenant } from '../core/context';
import { generateAccessToken } from '../config/jwt';
import { createSession } from '../modules/auth/session.service';
import { createTenant, SUPER_ADMIN_SLUG } from '../modules/tenants';
import { createDemoData } from '../modules/students/demo-data';
import { app } from '../app';

/**
 * Checks that one school can't see another's data.
 *
 *   npm run isolation:check -- --a dps --b iso-b --api http://localhost:8000/api [--create-b]
 *
 *  1. The schema: every uniqueness rule of a school's table includes the school.
 *  2. School B (with --create-b it is created with demo data if it isn't there).
 *  3. Signed in as school A's Super Admin, every GET route of the API is called: once as it is,
 *     and routes with ids once with each of a sample of school B's record ids. Any of school B's
 *     ids in an answer is a leak.
 *  4. A school code header (X-School) never moves a signed-in person to another school.
 * Needs the backend running at --api. Prints a report; exits 1 when something leaked.
 */

const out = (line = '') => process.stdout.write(line + '\n');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] }; regexp?: RegExp };

/** GET routes of the app, with their mount paths (Express 4 router stacks). */
const getRoutes = () => {
    const routes: string[] = [];
    const prefixOf = (re?: RegExp) => {
        if (!re) return '';
        const src = re.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\(\?=\\\/\|\$\)$/i, '').replace(/\\\//g, '/');
        return src === '/?' || src === '' ? '' : src.replace(/\/\?$/, '');
    };
    const walk = (stack: Layer[], base: string) => {
        for (const l of stack) {
            if (l.route && l.route.methods.get) routes.push(`${base}${l.route.path}`.replace(/\/+/g, '/'));
            else if (l.name === 'router' && l.handle?.stack) walk(l.handle.stack, base + prefixOf(l.regexp));
        }
    };
    walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '');
    return [...new Set(routes)].filter((r) => r.startsWith('/api/') && !r.startsWith('/api/platform/'));
};

/** 1. Uniqueness rules of school tables without the school in them. */
const schemaCheck = () => {
    const problems: string[] = [];
    for (const m of Prisma.dmmf.datamodel.models) {
        if (!m.fields.some((f) => f.name === 'tenantId') || m.name === 'Tenant') continue;
        for (const f of m.fields) if (f.isUnique && f.name !== 'id') problems.push(`${m.name}.${f.name} is unique across all schools`);
        for (const u of m.uniqueFields) if (!u.includes('tenantId') && !(u.length === 1 && u[0] === 'id')) problems.push(`${m.name} @@unique(${u.join(', ')}) has no tenantId`);
    }
    return problems;
};

(async () => {
    const { values } = parseArgs({ options: { a: { type: 'string' }, b: { type: 'string' }, api: { type: 'string' }, 'create-b': { type: 'boolean' } } });
    const api = (values.api ?? 'http://localhost:8000/api').replace(/\/$/, '');
    if (!values.a || !values.b) {
        out('Usage: npm run isolation:check -- --a <school code> --b <school code> --api http://localhost:8000/api [--create-b]');
        process.exit(1);
    }

    out('1. Schema');
    const schema = schemaCheck();
    for (const p of schema) out(`   ✗ ${p}`);
    out(schema.length ? `   ${schema.length} rule(s) to look at (a table not tied to a school on purpose can be fine).` : '   ✓ every uniqueness rule includes the school');

    const [A, B0] = await runAsSystem(() => Promise.all([db.tenant.findUnique({ where: { code: values.a! } }), db.tenant.findUnique({ where: { code: values.b! } })]));
    if (!A) throw new Error(`No school ${values.a}`);
    let B = B0;
    if (!B) {
        if (!values['create-b']) throw new Error(`No school ${values.b} (add --create-b to create it with demo data)`);
        out(`\n2. Creating school ${values.b} with demo data (a few minutes)…`);
        const created = await createTenant({ code: values.b, name: `Isolation Test School (${values.b})`, admin: { displayName: 'Isolation Admin', username: 'admin' } });
        await runAsTenant(created.tenant.id, () => createDemoData({ perSection: [3, 4] }));
        B = created.tenant;
    } else out(`\n2. School B: ${B.name}`);

    // School B's record ids: up to 15 from every table, and one "typical" id per table for the id routes.
    const bIds = new Set<string>();
    const samples: { table: string; id: string }[] = [];
    await runAsSystem(async () => {
        for (const m of Prisma.dmmf.datamodel.models) {
            if (!m.fields.some((f) => f.name === 'tenantId') || !m.fields.some((f) => f.name === 'id')) continue;
            const client = (db as unknown as Record<string, { findMany: (a: object) => Promise<{ id: string }[]> }>)[m.name[0].toLowerCase() + m.name.slice(1)];
            const rows = await client.findMany({ where: { tenantId: B!.id }, select: { id: true }, take: 15 });
            rows.forEach((r) => bIds.add(String(r.id)));
            if (rows[0]) samples.push({ table: m.name, id: String(rows[0].id) });
        }
    });
    bIds.add(B.id);
    out(`   ${bIds.size} of school B's record ids to look for, ${samples.length} tables`);

    // School A's Super Admin, signed in by this script.
    const admin = await runAsTenant(A.id, () => db.user.findFirst({ where: { status: 'active', roles: { some: { role: { slug: SUPER_ADMIN_SLUG } } } }, select: { id: true, username: true } }));
    if (!admin) throw new Error(`School ${A.code} has no active Super Admin`);
    const { session } = await runAsTenant(A.id, () => createSession(admin.id, A.id, false, { ip: '127.0.0.1', userAgent: 'isolation-check' }));
    const token = generateAccessToken({ userId: admin.id, tenantId: A.id, sessionId: session.id }, 3600);
    const call = async (path: string, extra: Record<string, string> = {}) => {
        try {
            const r = await fetch(`${api}${path.replace(/^\/api/, '')}`, { headers: { authorization: `Bearer ${token}`, ...extra }, signal: AbortSignal.timeout(60_000) });
            const type = r.headers.get('content-type') ?? '';
            const body = type.includes('json') || type.includes('text') ? await r.text() : '';
            return { status: r.status, body };
        } catch (err) {
            return { status: 0, body: (err as Error).message };
        }
    };

    out(`\n3. Calling every GET route as ${A.code}'s Super Admin (${admin.username})`);
    const routes = getRoutes();
    const leaks: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const leaked = (body: string) => [...new Set(body.match(UUID) ?? [])].filter((id) => bIds.has(id.toLowerCase()));
    for (const r of routes) {
        const params = r.match(/:[A-Za-z_]+(\([^)]*\))?\??/g) ?? [];
        if (!params.length) {
            const res = await call(r);
            calls++;
            const found = res.status < 300 ? leaked(res.body) : [];
            if (found.length) leaks.push(`GET ${r} → shows school B's ${found.slice(0, 3).join(', ')}`);
            if (res.status >= 500 || res.status === 0) errors.push(`GET ${r} → ${res.status || 'no answer'}`);
            continue;
        }
        for (const s of samples) {
            // Every :param gets the same id (a route usually takes one record's id).
            const path = params.reduce((p, x) => p.replace(x, s.id), r);
            const res = await call(path);
            calls++;
            const found = res.status < 300 ? leaked(res.body) : [];
            if (found.length) leaks.push(`GET ${r} with ${s.table} ${s.id} → ${res.status}, shows school B's ${found.slice(0, 3).join(', ')}`);
            if (res.status >= 500) errors.push(`GET ${path} → ${res.status}`);
        }
    }
    out(`   ${routes.length} routes, ${calls} calls`);

    out('\n4. A school code header for school B, signed in to school A');
    const me = await call('/api/auth/me', { 'x-school': B.code });
    const stays = me.status === 200 && !leaked(me.body).length && me.body.includes(admin.id);
    out(stays ? '   ✓ still school A' : `   ✗ answer ${me.status}: ${me.body.slice(0, 200)}`);
    if (!stays) leaks.push('X-School header changed the school of a signed-in person');

    out('\nResult');
    if (leaks.length) {
        out(`   ✗ ${leaks.length} leak(s):`);
        for (const l of leaks) out(`     - ${l}`);
    } else out("   ✓ no school B data in any answer to school A");
    if (errors.length) {
        out(`   ${errors.length} server error(s) (not leaks, but worth fixing):`);
        for (const e of errors.slice(0, 40)) out(`     - ${e}`);
    }
    await runAsTenant(A.id, () => db.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'isolation check finished' } })).catch(() => undefined);
    await db.$disconnect();
    process.exit(leaks.length ? 1 : 0);
})().catch(async (err) => {
    out(`Failed: ${(err as Error).message}`);
    await db.$disconnect().catch(() => undefined);
    process.exit(1);
});
