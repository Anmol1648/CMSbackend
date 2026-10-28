import type { z } from 'zod';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { esc, qrSvg } from '../../core/pdf/codes';
import { labels, labelsQuery } from './assets.service';

/** Asset labels as an A4 PDF, printed from the app or the website. */

const A4 = { size: 'A4' as const, orientation: 'portrait' as const, margin: 8 };

/** QR labels, 4 across: the school, the asset's code (scanning it opens the asset), its name, room and quantity. */
export const labelsPdf = async (q: z.infer<typeof labelsQuery>) => {
    const l = await labels(q);
    const cells = await Promise.all(
        l.labels.map(
            async (x) =>
                `<div class="label no-break"><div class="qr">${await qrSvg(x.code)}</div><div class="text">` +
                `<p class="school">${esc(l.school)}</p><p class="code">${esc(x.code)}</p><p class="name">${esc(x.name)}</p>` +
                `<p class="room">${esc([x.room, x.quantity > 1 ? `${x.quantity} items` : null].filter(Boolean).join(' · '))}</p></div></div>`,
        ),
    );
    const css = `.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; }
.label { display: flex; align-items: center; gap: 1.5mm; border: 1px dashed #999; border-radius: 2mm; padding: 2mm; overflow: hidden; }
.qr svg { width: 15mm; height: 15mm; display: block; } .text { min-width: 0; }
.text p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.school { font-size: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
.code { font-size: 9px; font-weight: 900; font-family: monospace; } .name { font-size: 7.5px; font-weight: 600; } .room { font-size: 6.5px; }`;
    return { count: l.labels.length, pdf: await htmlToPdf(pageHtml(`<div class="grid">${cells.join('')}</div>`, css, A4), A4) };
};
