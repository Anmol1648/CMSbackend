import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { getSettings } from '../../core/settings';
import { htmlToPdf, htmlToPng, pageHtml } from '../../core/pdf';
import { barcodeSvg, esc, imageData, qrSvg } from '../../core/pdf/codes';
import { designSchema, Holder, HolderType, holders, mine, school } from './idcards.service';
import { IDCARDS } from './idcards.settings';

/**
 * ID cards drawn on the server, the same as the website draws them (IdCard.tsx): A4 sheets or one
 * card per page to print (PDF), and pictures of one side for the app's digital card and the
 * design preview (PNG). Everything is inline (photos, logo, signature as data: URLs).
 */

type DesignLike = z.infer<typeof designSchema>;
type CardHolder = Holder & { labels?: Record<string, string> };
interface Look {
    design: DesignLike;
    school: { name: string; short: string };
    logo: string | null;
    signature: string | null;
}

/** Field labels on the card (kept short: the card is small). */
const LABELS: Record<string, string> = {
    class: 'Class',
    admissionNo: 'Adm. No',
    rollNo: 'Roll No',
    dob: 'D.O.B',
    bloodGroup: 'Blood Gr.',
    father: 'Father',
    mother: 'Mother',
    phone: 'Phone',
    address: 'Address',
    transport: 'Bus',
    house: 'House',
    emergency: 'Emergency',
    validUntil: 'Valid till',
    cardNo: 'Card No',
    designation: 'Designation',
    department: 'Department',
    employeeCode: 'Emp. Code',
    joiningDate: 'Joined',
    schoolAddress: 'School',
};

const size = (d: DesignLike) => (d.orientation === 'portrait' ? { w: 54, h: 85.6 } : { w: 85.6, h: 54 });
const mm = (n: number) => `${n}mm`;

/** One side of a card, in real millimetres (CR80: 85.6 × 54). `photo` is a data: URL. */
const side = async (look: Look, holder: CardHolder, photo: string | null, which: 'front' | 'back', bare = false) => {
    const { design } = look;
    const portrait = design.orientation === 'portrait';
    const { w, h } = size(design);
    const cardNo = holder.card?.cardNo ?? holder.values.cardNo ?? '';
    const shownNo = cardNo || 'ID-••••••';
    const v = (k: string) => (k === 'cardNo' ? shownNo : k === 'validUntil' ? holder.values.validUntil || 'on printing' : (holder.values[k] ?? ''));
    const list = (keys: string[]) => keys.filter((k) => !['photo', 'name'].includes(k) && v(k));
    const rows = (keys: string[], fs = 2.05) =>
        `<table class="rows" style="font-size:${mm(fs)}"><tbody>${keys
            .map((k) => `<tr><td class="k">${esc(LABELS[k] ?? holder.labels?.[k] ?? k)}</td><td class="v">${esc(v(k))}</td></tr>`)
            .join('')}</tbody></table>`;
    const card = (inner: string) =>
        `<div class="idcard${bare ? ' bare' : ''}" style="width:${mm(w)};height:${mm(h)}">${inner}</div>`;
    const bar = (height: number) => `<div style="background:${design.color};height:${mm(height)};flex-shrink:0"></div>`;

    if (which === 'back') {
        const sign =
            look.signature || design.signatureLabel
                ? `<div class="sign">${look.signature ? `<img src="${look.signature}" alt="">` : ''}<div class="sline">${esc(design.signatureLabel || 'Signature')}</div></div>`
                : '';
        return card(
            `${bar(3)}<div class="back">${rows(list(design.backFields), 2)}${design.backText ? `<div class="btext">${esc(design.backText)}</div>` : ''}` +
                `<div class="bfoot"><div class="bno">${LABELS.cardNo}: <b>${esc(shownNo)}</b></div>${sign}</div></div>${bar(1.5)}`,
        );
    }

    const header = (tall: boolean) =>
        `<div class="head" style="background:${design.color};color:${design.textColor};padding:${mm(tall ? 2 : 1.3)} ${mm(2.5)}">` +
        (look.logo ? `<img class="logo" src="${look.logo}" alt="" style="width:${mm(tall ? 9 : 7)};height:${mm(tall ? 9 : 7)}">` : '') +
        `<div class="htext"><div class="hname" style="font-size:${mm(tall ? 3.1 : 2.8)}">${esc(look.school.short || look.school.name)}</div>` +
        `<div class="hsub">${holder.type === 'staff' ? 'Staff identity card' : 'Student identity card'}</div></div></div>`;
    const photoBox = design.fields.includes('photo')
        ? `<div class="photo" style="width:${mm(portrait ? 21 : 19)};height:${mm(portrait ? 26 : 24)};border-color:${design.color}">${photo ? `<img src="${photo}" alt="">` : '<div class="nophoto">No photo</div>'}</div>`
        : '';
    const code =
        design.code === 'qr'
            ? `<div class="qr" style="width:${mm(portrait ? 12 : 11.5)};height:${mm(portrait ? 12 : 11.5)}">${await qrSvg(shownNo)}</div>`
            : design.code === 'barcode'
              ? `<div class="bc" style="width:${mm(34)}">${barcodeSvg(shownNo, 22)}</div>`
              : '';
    const name = (fs: number, center: boolean) =>
        design.fields.includes('name') ? `<div class="name" style="font-size:${mm(fs)};color:${design.color};${center ? 'text-align:center;' : ''}">${esc(holder.name)}</div>` : '';
    const body = portrait
        ? `<div class="pbody">${photoBox}${name(3.1, true)}<div class="fill">${rows(list(design.fields))}</div><div class="center">${code}</div></div>`
        : `<div class="lbody"><div class="lcol">${photoBox}${design.code === 'qr' ? code : ''}</div>` +
          `<div class="lmain">${name(3.2, false)}<div class="fill">${rows(list(design.fields), 2)}</div>${design.code === 'barcode' ? code : ''}</div></div>`;
    return card(`${header(portrait)}${body}${bar(1.5)}`);
};

const CSS = `
.idcard { background:#fff; border:0.2mm solid #ccc; border-radius:2.5mm; overflow:hidden; display:flex; flex-direction:column; font-family: Inter, 'Segoe UI', Arial, sans-serif; break-inside: avoid; }
.idcard.bare { border:none; border-radius:0; }
.head { display:flex; align-items:center; gap:2mm; flex-shrink:0; }
.logo { object-fit:contain; background:#fff; border-radius:1.2mm; padding:0.4mm; }
.htext { min-width:0; line-height:1.15; }
.hname { font-weight:800; text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hsub { font-size:1.7mm; opacity:.85; }
.rows { width:100%; border-collapse:collapse; line-height:1.25; }
.rows td { padding:0; }
.rows .k { color:#555; padding-right:1mm; white-space:nowrap; vertical-align:top; width:1%; }
.rows .v { font-weight:600; color:#111; word-break:break-word; }
.photo { border:0.5mm solid; border-radius:1.2mm; overflow:hidden; background:#eef1f5; flex-shrink:0; }
.photo img { width:100%; height:100%; object-fit:cover; display:block; }
.nophoto { font-size:1.8mm; color:#999; text-align:center; padding-top:10mm; }
.name { font-weight:800; line-height:1.1; }
.pbody { flex:1; display:flex; flex-direction:column; align-items:center; padding:2mm 2.8mm 1.5mm; gap:1mm; overflow:hidden; }
.lbody { flex:1; display:flex; padding:1.8mm 2.5mm; gap:2.5mm; overflow:hidden; }
.lcol { display:flex; flex-direction:column; align-items:center; gap:1mm; }
.lmain { flex:1; min-width:0; display:flex; flex-direction:column; gap:0.8mm; }
.fill { width:100%; flex:1; overflow:hidden; }
.center { display:flex; justify-content:center; width:100%; }
.qr svg { width:100%; height:100%; display:block; }
.bc svg { width:100%; height:9mm; display:block; }
.back { padding:2mm 2.8mm; flex:1; display:flex; flex-direction:column; gap:1.5mm; overflow:hidden; }
.btext { font-size:1.8mm; color:#333; white-space:pre-line; line-height:1.3; }
.bfoot { margin-top:auto; display:flex; align-items:flex-end; justify-content:space-between; gap:2mm; }
.bno { font-size:1.8mm; color:#555; } .bno b { color:#111; }
.sign { text-align:center; } .sign img { height:7mm; max-width:22mm; object-fit:contain; display:block; margin:0 auto; }
.sline { font-size:1.7mm; border-top:0.2mm solid #999; padding-top:0.3mm; min-width:16mm; }
.sheet { display:flex; flex-wrap:wrap; gap:4mm; }
.sheet.mirror { flex-direction:row-reverse; justify-content:flex-start; }
.pg { break-after:page; } .pg:last-child { break-after:auto; }`;

/** The school's look: short name, logo and the design's signature, all inline. */
const lookOf = async (design: DesignLike): Promise<Look> => {
    const [sch, profile] = await Promise.all([school(), db.schoolProfile.findFirst({ select: { logoFileId: true } })]);
    return { design, school: sch, logo: await imageData(profile?.logoFileId), signature: await imageData(design.signatureFileId) };
};

/** Each person's photo as a data: URL. */
const photosOf = async (type: HolderType, ids: string[]) => {
    const rows = type === 'student' ? await db.student.findMany({ where: { id: { in: ids } }, select: { id: true, photoFileId: true } }) : await db.staff.findMany({ where: { id: { in: ids } }, select: { id: true, photoFileId: true } });
    const out = new Map<string, string | null>();
    for (const r of rows) out.set(r.id, await imageData(r.photoFileId));
    return out;
};

const designRow = async (id: string, type: HolderType) => {
    const d = await db.idCardDesign.findFirst({ where: { id, kind: type } });
    if (!d) throw badRequest('Choose a design for this kind of card');
    return d as unknown as DesignLike;
};

/** A page per card side, sized exactly to the card (card printers). */
const singlePages = async (look: Look, people: CardHolder[], photos: Map<string, string | null>, backs: boolean) => {
    const out: string[] = [];
    for (const p of people) {
        out.push(`<div class="pg">${await side(look, p, photos.get(p.id) ?? null, 'front', true)}</div>`);
        if (backs && look.design.back) out.push(`<div class="pg">${await side(look, p, photos.get(p.id) ?? null, 'back', true)}</div>`);
    }
    return out.join('');
};

const singlePdf = async (look: Look, people: CardHolder[], photos: Map<string, string | null>, backs: boolean) => {
    const { w, h } = size(look.design);
    const html = pageHtml(await singlePages(look, people, photos, backs), `${CSS}\n@page { size: ${w}mm ${h}mm; margin: 0; }`, { size: 'A4', orientation: 'portrait', margin: 0 });
    // pageHtml's own @page comes first; the card-sized one above wins (it comes later).
    return htmlToPdf(html, { size: 'A4', orientation: 'portrait', margin: 0 });
};

export const cardsPdfSchema = z.strictObject({
    type: z.enum(['student', 'staff']),
    designId: z.uuid(),
    ids: z.array(z.uuid()).min(1).max(1000),
    mode: z.enum(['sheet', 'single']).default('sheet'),
    backs: z.boolean().default(true),
});

/** Cards to print: A4 sheets (fronts, then the backs mirrored for two-sided printing) or one side per page. Doesn't record a print. */
export const cardsPdf = async (input: z.infer<typeof cardsPdfSchema>) => {
    const design = await designRow(input.designId, input.type);
    const [look, people, photos] = await Promise.all([lookOf(design), holders(input.type, input.ids), photosOf(input.type, input.ids)]);
    if (!people.length) throw badRequest('No one to print');
    if (input.mode === 'single') return singlePdf(look, people, photos, input.backs);
    const portrait = design.orientation === 'portrait';
    const across = portrait ? 3 : 2;
    const perPage = portrait ? 9 : 10;
    const width = across * size(design).w + (across - 1) * 4;
    const pages: string[] = [];
    for (let i = 0; i < people.length; i += perPage) {
        const group = people.slice(i, i + perPage);
        const fronts = await Promise.all(group.map((p) => side(look, p, photos.get(p.id) ?? null, 'front')));
        pages.push(`<div class="pg sheet" style="width:${width}mm">${fronts.join('')}</div>`);
        if (input.backs && design.back) {
            const backs = await Promise.all(group.map((p) => side(look, p, photos.get(p.id) ?? null, 'back')));
            pages.push(`<div class="pg sheet mirror" style="width:${width}mm">${backs.join('')}</div>`);
        }
    }
    const A4 = { size: 'A4' as const, orientation: 'portrait' as const, margin: 10 };
    return htmlToPdf(pageHtml(pages.join(''), CSS, A4), A4);
};

/** A sample person for the design preview. */
const sampleHolder = (kind: HolderType): CardHolder => ({
    type: kind,
    id: 'sample',
    name: kind === 'staff' ? 'Anita Sharma' : 'Rohan Negi',
    photo: null,
    sub: '',
    card: { id: '', cardNo: 'ID-000123', validUntil: '', status: 'active' },
    values:
        kind === 'staff'
            ? { designation: 'TGT (Science)', department: 'Science', employeeCode: 'EMP-0042', joiningDate: '01 Jul 2019', dob: '12 Mar 1988', bloodGroup: 'B+', phone: '9876543210', address: 'Gopeshwar, Chamoli - 246401', emergency: 'Rakesh Sharma · 9876500000', validUntil: '31 Mar 2027', cardNo: 'ID-000123', schoolAddress: 'Main Road, Joshimath · Ph 01389-222222' }
            : { class: 'VII-B', admissionNo: '2025/0102', rollNo: '12', dob: '05 Aug 2013', bloodGroup: 'O+', father: 'Mahesh Negi', mother: 'Sunita Negi', phone: '9876543210', address: 'Upper Bazaar, Joshimath - 246443', transport: 'Route 3 · Marwari', house: 'Nanda', emergency: 'Mahesh Negi · 9876543210', validUntil: '31 Mar 2027', cardNo: 'ID-000123', schoolAddress: 'Main Road, Joshimath · Ph 01389-222222' },
});

/** One side as a picture, the card's own size (rounded corners show on a white background). */
const sidePng = async (look: Look, holder: CardHolder, photo: string | null, which: 'front' | 'back') => {
    const { w, h } = size(look.design);
    const html = pageHtml(await side(look, holder, photo, which), CSS, { size: 'A4', orientation: 'portrait', margin: 0 });
    return htmlToPng(html, { widthMm: w, heightMm: h });
};

export const previewSchema = z.strictObject({ design: designSchema, side: z.enum(['front', 'back']).default('front') });

/** The design being edited, on a sample person. */
export const previewPng = async (input: z.infer<typeof previewSchema>) => sidePng(await lookOf(input.design), sampleHolder(input.design.kind), null, input.side);

/** My (or my child's) card, only for the people of this login and when the school shows digital cards. */
export const myCard = async (userId: string, type: HolderType, holderId: string) => {
    const s = await getSettings({ digital: IDCARDS.digital });
    if (!s.digital) throw forbidden('The school doesn’t show digital ID cards');
    const m = await mine(userId);
    const ok = type === 'staff' ? m.staffId === holderId : m.studentIds.includes(holderId);
    if (!ok) throw notFound('Card not found');
    const [holder] = await holders(type, [holderId]);
    if (!holder) throw notFound('Card not found');
    const card = await db.idCard.findFirst({ where: { holderType: type, status: 'active', ...(type === 'student' ? { studentId: holderId } : { staffId: holderId }) }, select: { designId: true } });
    const designs = await db.idCardDesign.findMany({ where: { isActive: true, kind: type } });
    const design = designs.find((d) => d.id === card?.designId) ?? designs.find((d) => d.isDefault) ?? designs[0];
    if (!design) throw notFound('No card design yet');
    const photo = (await photosOf(type, [holderId])).get(holderId) ?? null;
    return { look: await lookOf(design as unknown as DesignLike), holder: holder as CardHolder, photo };
};

export const myCardPng = async (userId: string, type: HolderType, holderId: string, which: 'front' | 'back') => {
    const c = await myCard(userId, type, holderId);
    if (which === 'back' && !c.look.design.back) throw notFound('This card has no back');
    return sidePng(c.look, c.holder, c.photo, which);
};

export const myCardPdf = async (userId: string, type: HolderType, holderId: string) => {
    const c = await myCard(userId, type, holderId);
    return { pdf: await singlePdf(c.look, [c.holder], new Map([[holderId, c.photo]]), true), name: c.holder.name };
};
