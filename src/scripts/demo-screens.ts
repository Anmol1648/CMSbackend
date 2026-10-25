/**
 * Takes the screenshots for the demo deck (Platform console → Demo deck) from a running ERP:
 * signs in as the demo school's admin, teacher and parent and saves each screen to
 * assets/demo-deck/<key>.jpg. Run it again after the screens change.
 *
 *   npm run demo:screens -- --app http://localhost:3000 --api http://localhost:8000/api --school dps
 */
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import puppeteer, { Page } from 'puppeteer-core';
import '../config/env';
import { db } from '../core/db';
import { runAsSystem, runAsTenant } from '../core/context';
import { DECK_SCREENS } from '../modules/platform/demo-deck';

const out = (line = '') => process.stdout.write(line + '\n');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const DIR = path.join(process.cwd(), 'assets', 'demo-deck');
const PASSWORD = 'Demo@2026';
const USERS = { admin: 'kuldeep.chauhan', teacher: 'deepak.rautela', parent: '9373993122', student: '20250235' } as const;

const main = async () => {
    const { values } = parseArgs({ options: { app: { type: 'string', default: 'http://localhost:3000' }, api: { type: 'string', default: 'http://localhost:8000/api' }, school: { type: 'string', default: 'dps' }, only: { type: 'string' } } });
    const exe = process.env.PDF_BROWSER_PATH || CHROME.find((c) => fs.existsSync(c));
    if (!exe) throw new Error('No Chrome / Edge found (set PDF_BROWSER_PATH)');
    fs.mkdirSync(DIR, { recursive: true });
    // Records some screens open (a student's profile).
    const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { code: values.school! } }));
    if (!tenant) throw new Error(`No school ${values.school}`);
    const ids = await runAsTenant(tenant.id, async () => ({
        student: (await db.student.findFirst({ where: { admissionNo: '2025/0235' }, select: { id: true } }))?.id ?? (await db.student.findFirst({ select: { id: true } }))!.id,
        competition: (await db.competition.findFirst({ where: { name: 'Inter-house Debate' }, select: { id: true } }))?.id ?? '',
    }));
    const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--hide-scrollbars'] });
    const shoot = async (page: Page, file: string) => {
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 30_000 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1500));
        await page.screenshot({ path: path.join(DIR, `${file}.jpg`), type: 'jpeg', quality: 82 });
    };
    const signedIn = async (who: keyof typeof USERS | null, mobile = false) => {
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900, deviceScaleFactor: 1 });
        await page.goto(`${values.app}/login`, { waitUntil: 'networkidle2', timeout: 90_000 });
        if (who) {
            const ok = await page.evaluate(
                async (api: string, school: string, identifier: string, password: string) => {
                    localStorage.setItem('school-code', school);
                    const r = await fetch(`${api}/auth/login`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-School': school }, body: JSON.stringify({ identifier, password }) });
                    return r.ok;
                },
                values.api!,
                values.school!,
                USERS[who],
                PASSWORD
            );
            if (!ok) throw new Error(`Could not sign in as ${USERS[who]}`);
        }
        return { page, close: () => ctx.close() };
    };

    const only = values.only ? new Set(values.only.split(',')) : null;
    for (const who of ['none', 'admin', 'teacher', 'parent', 'student', 'mobile'] as const) {
        const list = DECK_SCREENS.filter((s) => s.as === who && (!only || only.has(s.key)));
        if (!list.length) continue;
        const { page, close } = await signedIn(who === 'none' ? null : who === 'mobile' ? 'parent' : who, who === 'mobile');
        for (const s of list) {
            const url = `${values.app}${s.path.replace(':student', ids.student).replace(':competition', ids.competition)}`;
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 90_000 });
                await shoot(page, s.key);
                out(`✓ ${s.key}  ${s.path}`);
            } catch (e) {
                out(`✗ ${s.key}  ${(e as Error).message}`);
            }
        }
        await close();
    }
    await browser.close();
    await db.$disconnect();
};

main().catch((e) => {
    out(`Failed: ${(e as Error).message}`);
    process.exit(1);
});
