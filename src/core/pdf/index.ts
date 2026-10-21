import fs from 'fs';
import path from 'path';
import puppeteer, { Browser } from 'puppeteer-core';
import { env } from '../../config/env';
import { AppError } from '../errors';
import { ErrorCode } from '../index';
import { logger } from '../logger';

/**
 * HTML → PDF with a headless Chrome / Chromium / Edge (one shared browser, a new page per
 * document). Templates can't run scripts or fetch anything: JavaScript is off and every request
 * except embedded data: URLs is refused (no reaching into the server's network).
 */

export type PaperSize = 'A4' | 'A5' | 'A4_HALF' | 'THERMAL_80';

export interface Paper {
    size: PaperSize;
    orientation: 'portrait' | 'landscape';
    /** Page margins in mm. */
    margin: number;
}

const SIZES: Record<PaperSize, { width: string; height: string | null }> = {
    A4: { width: '210mm', height: '297mm' },
    A5: { width: '148mm', height: '210mm' },
    // Half an A4 sheet (two receipts per sheet, cut in the middle).
    A4_HALF: { width: '210mm', height: '148.5mm' },
    // An 80 mm receipt roll: the page is as long as the content.
    THERMAL_80: { width: '80mm', height: null },
};

const CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const browserPath = () => {
    const found = env.PDF_BROWSER_PATH ?? CANDIDATES.find((p) => fs.existsSync(p));
    if (!found) throw new AppError('PDF documents need Chrome, Chromium or Edge on the server (set PDF_BROWSER_PATH)', 500, ErrorCode.INTERNAL_SERVER_ERROR);
    return path.normalize(found);
};

let launching: Promise<Browser> | null = null;
const browser = () => {
    if (!launching) {
        launching = puppeteer
            .launch({ executablePath: browserPath(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'] })
            .then((b) => {
                b.on('disconnected', () => {
                    launching = null;
                });
                return b;
            })
            .catch((err) => {
                launching = null;
                throw err;
            });
    }
    return launching;
};

/** A complete HTML page for a document body and its CSS, sized for the paper. */
export const pageHtml = (body: string, css: string, paper: Paper) => {
    const s = SIZES[paper.size];
    const [w, h] = paper.orientation === 'landscape' && s.height ? [s.height, s.width] : [s.width, s.height];
    return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${w} ${h ?? 'auto'}; margin: ${paper.margin}mm; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color-scheme: light; }
body { font-family: 'Segoe UI', 'Noto Sans', 'Noto Sans Devanagari', 'Nirmala UI', Arial, sans-serif; font-size: 11px; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page-break { break-after: page; }
.no-break { break-inside: avoid; }
.cut-line { border-top: 1px dashed #999; margin: 10mm 0; position: relative; height: 0; }
.cut-line span { position: absolute; left: 50%; top: -7px; transform: translateX(-50%); background: #fff; padding: 0 6px; font-size: 8px; color: #999; }
${css}
</style></head><body>${body}</body></html>`;
};

/**
 * Renders the HTML to PDF bytes. `footer` (optional) is a line printed at the bottom of every page;
 * {page} and {pages} in it become the page number and the page count.
 */
export const htmlToPdf = async (html: string, paper: Paper, footer?: string): Promise<Buffer> => {
    const b = await browser();
    const page = await b.newPage();
    try {
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (r) => (r.url().startsWith('data:') ? r.continue() : r.abort()));
        const s = SIZES[paper.size];
        // A roll is measured at its own width (96 px per inch = 3.78 px per mm).
        if (!s.height) await page.setViewport({ width: Math.round(80 * 3.78), height: 600 });
        await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
        const landscape = paper.orientation === 'landscape' && !!s.height;
        const footerHtml = footer
            ? `<div style="width:100%;font-size:7px;color:#666;padding:0 ${paper.margin}mm;display:flex;justify-content:space-between;font-family:'Segoe UI',Arial,sans-serif"><span>${escapeHtml(footer)
                  .replace('{page}', '<span class="pageNumber"></span>')
                  .replace('{pages}', '<span class="totalPages"></span>')
                  .replace(' | ', '</span><span>')}</span></div>`
            : undefined;
        const pdf = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            ...(footerHtml ? { displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footerHtml } : {}),
            ...(s.height ? { width: landscape ? s.height : s.width, height: landscape ? s.width : s.height } : { width: s.width, height: `${Math.ceil((await page.evaluate(() => document.documentElement.scrollHeight)) * 0.2646) + paper.margin * 2 + 2}mm` }),
        });
        return Buffer.from(pdf);
    } catch (err) {
        logger.error('PDF rendering failed', { error: (err as Error).message });
        throw new AppError('The document could not be made. Please try again.', 500, ErrorCode.INTERNAL_SERVER_ERROR);
    } finally {
        await page.close().catch(() => undefined);
    }
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Closes the shared browser (tests, shutdown). */
export const closePdfBrowser = async () => {
    if (!launching) return;
    const b = await launching.catch(() => null);
    launching = null;
    await b?.close().catch(() => undefined);
};
