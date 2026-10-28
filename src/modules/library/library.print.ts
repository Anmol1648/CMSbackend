import type { z } from 'zod';
import { db } from '../../core/db';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { barcodeSvg, esc, imageData, qrSvg } from '../../core/pdf/codes';
import { labels, labelsQuery } from './books.service';
import { cards, cardsQuery } from './members.service';

/** Book labels and library cards as A4 PDFs, printed from the app or the website. */

const A4 = { size: 'A4' as const, orientation: 'portrait' as const, margin: 8 };

/** Spine / inside-cover labels, 4 across: the school, the book, its shelf and the accession number as a barcode and a QR code. */
export const labelsPdf = async (q: z.infer<typeof labelsQuery>) => {
    const l = await labels(q);
    const cells = await Promise.all(
        l.labels.map(
            async (x) =>
                `<div class="label no-break"><p class="school">${esc(l.school)} Library</p><p class="title">${esc(x.title)}</p>` +
                `<div class="codes"><div class="qr">${await qrSvg(x.accessionNo)}</div>${barcodeSvg(x.accessionNo)}</div>` +
                `<p class="shelf">${esc([x.callNumber, x.location].filter(Boolean).join(' · '))}</p></div>`,
        ),
    );
    const css = `.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; }
.label { border: 1px dashed #999; border-radius: 2mm; padding: 2mm; text-align: center; overflow: hidden; }
.label p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.school { font-size: 7px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; } .title { font-size: 8px; font-weight: 600; }
.codes { display: flex; align-items: center; justify-content: center; gap: 1.5mm; margin: 1mm 0; }
.qr svg { width: 11mm; height: 11mm; display: block; } .barcode { width: 28mm; height: 12mm; } .shelf { font-size: 7px; }`;
    return { count: l.labels.length, pdf: await htmlToPdf(pageHtml(`<div class="grid">${cells.join('')}</div>`, css, A4), A4) };
};

/** Library cards the size of a bank card, 10 on an A4 page: school, photo, name, class, limits, and the member's number as a barcode and a QR code. */
export const cardsPdf = async (q: z.infer<typeof cardsQuery>) => {
    const c = await cards(q);
    const school = await db.schoolProfile.findFirst({ select: { logoFileId: true } });
    const logo = await imageData(school?.logoFileId);
    const photoIds = new Map<string, string | null>();
    const studentIds = c.cards.filter((x) => x.kind === 'student' && x.hasPhoto).map((x) => x.id);
    const staffIds = c.cards.filter((x) => x.kind === 'staff' && x.hasPhoto).map((x) => x.id);
    for (const s of await db.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, photoFileId: true } })) photoIds.set(`student:${s.id}`, s.photoFileId);
    for (const s of await db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, photoFileId: true } })) photoIds.set(`staff:${s.id}`, s.photoFileId);
    const validTill = c.validTill ? new Date(`${c.validTill}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
    const items = await Promise.all(
        c.cards.map(async (x) => {
            const photo = await imageData(photoIds.get(`${x.kind}:${x.id}`));
            return (
                `<div class="card no-break"><div class="band">${logo ? `<img class="logo" src="${logo}">` : ''}` +
                `<div><p class="school">${esc(c.school.name)}</p><p class="sub">Library card${c.session ? ` · ${esc(c.session)}` : ''}</p></div></div>` +
                `<div class="body">${photo ? `<img class="photo" src="${photo}">` : '<div class="photo none"></div>'}` +
                `<div class="who"><p class="name">${esc(x.name)}</p><p>${esc(x.detail)}</p><p class="small">${esc(x.type)}: ${x.books} book${x.books === 1 ? '' : 's'}, ${x.days} days</p>` +
                `${validTill ? `<p class="small">Valid till ${validTill}</p>` : ''}</div><div class="qr">${await qrSvg(x.code)}</div></div>` +
                `<div class="bar">${barcodeSvg(x.code, 26)}</div></div>`
            );
        }),
    );
    const css = `.grid { display: grid; grid-template-columns: repeat(2, 85.6mm); gap: 4mm; justify-content: center; }
.card { width: 85.6mm; height: 54mm; border: 1px solid #bbb; border-radius: 3mm; overflow: hidden; position: relative; }
.band { display: flex; align-items: center; gap: 2mm; background: #1A365D; color: #fff; padding: 1.5mm 3mm; }
.logo { height: 6mm; width: 6mm; background: #fff; border-radius: 1mm; object-fit: contain; }
.band p { margin: 0; } .school { font-size: 8px; font-weight: 800; text-transform: uppercase; } .sub { font-size: 7px; opacity: .85; }
.body { display: flex; gap: 2mm; padding: 2mm 3mm 0; }
.photo { width: 15mm; height: 19mm; object-fit: cover; border-radius: 1mm; border: 1px solid #ccc; flex: none; } .photo.none { background: #EDF2F7; }
.who { flex: 1; min-width: 0; } .who p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 8px; }
.who .name { font-size: 10px; font-weight: 800; } .small { color: #4A5568; font-size: 7px !important; margin-top: .5mm !important; }
.qr svg { width: 16mm; height: 16mm; display: block; }
.bar { position: absolute; left: 0; right: 0; bottom: 1.5mm; text-align: center; } .barcode { width: 55mm; height: 10mm; }`;
    return { count: c.cards.length, pdf: await htmlToPdf(pageHtml(`<div class="grid">${items.join('')}</div>`, css, A4), A4) };
};
