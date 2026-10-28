import { db } from '../../core/db';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { esc, imageData } from '../../core/pdf/codes';
import { poView } from './purchase.service';
import { saleView } from './sales.service';

/** A purchase order (A4) and a student sale slip (A5) as PDFs, printed from the app or the website. */

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The purchase order to send to the vendor: the school, the vendor, the lines with rate and GST, and signatures. */
export const poPdf = async (id: string) => {
    const [po, profile] = await Promise.all([poView(id), db.schoolProfile.findFirst({ select: { logoFileId: true } })]);
    const logo = await imageData(profile?.logoFileId);
    const td = (x: string, right = true) => `<td class="${right ? 'r' : ''}">${x}</td>`;
    const rows = po.lines.map((l, i) => `<tr>${td(String(i + 1))}${td(esc(l.item), false)}${td(`${qty(l.qty)} ${esc(l.unit)}`)}${td(money(l.rate))}${td(String(l.gstPct))}${td(money(l.amount))}</tr>`).join('');
    const body = `<div class="doc">
<div class="head">${logo ? `<img class="logo" src="${logo}">` : ''}<div class="school"><p class="name">${esc(po.school?.name)}</p><p>${esc(po.school?.address)}</p><p>${esc([po.school?.phone, po.school?.email].filter(Boolean).join(' · '))}</p></div>
<div class="title"><p class="big">PURCHASE ORDER</p><p>No. ${esc(po.number)}</p><p>Date ${esc(day(po.orderDate))}</p></div></div>
<div class="parties"><div><b>To:</b> ${esc(po.vendor)}${po.vendorInfo.phone ? `<br>Ph ${esc(po.vendorInfo.phone)}` : ''}${po.vendorInfo.gstin ? `<br>GSTIN ${esc(po.vendorInfo.gstin)}` : ''}</div>
<div class="r"><b>Deliver to:</b> ${esc(po.store)}${po.expectedOn ? `<br>By ${esc(day(po.expectedOn))}` : ''}</div></div>
<table><thead><tr><th class="r">#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">GST %</th><th class="r">Amount</th></tr></thead>
<tbody>${rows}<tr><td colspan="5" class="r b">Total</td><td class="r b">${money(po.total)}</td></tr></tbody></table>
${po.note ? `<p class="note">Note: ${esc(po.note)}</p>` : ''}
<div class="sign"><div>Prepared by: ${esc(po.createdByName)}</div><div class="line">Approved by${po.approvedByName ? `: ${esc(po.approvedByName)}` : ''}</div></div>
</div>`;
    const css = `.doc { font-family: Arial, sans-serif; font-size: 12px; color: #111; }
.head { display: flex; gap: 12px; align-items: center; border-bottom: 2px solid #1A365D; padding-bottom: 8px; } .head p { margin: 0; }
.logo { width: 56px; height: 56px; object-fit: contain; } .school { flex: 1; } .name { font-size: 18px; font-weight: 800; }
.title { text-align: right; } .big { font-size: 16px; font-weight: 800; }
.parties { display: flex; justify-content: space-between; margin: 10px 0; }
table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #999; padding: 4px; text-align: left; } th { background: #eef1f5; }
.r { text-align: right; } .b { font-weight: 800; } .note { margin-top: 10px; }
.sign { display: flex; justify-content: space-between; margin-top: 50px; } .line { border-top: 1px solid #333; padding-top: 4px; min-width: 180px; text-align: center; }`;
    const paper = { size: 'A4' as const, orientation: 'portrait' as const, margin: 12 };
    return { fileName: `${po.number}.pdf`, pdf: await htmlToPdf(pageHtml(body, css, paper), paper) };
};

/** The slip for a student sale: added to the fees, or paid at the counter. */
export const salePdf = async (id: string) => {
    const s = await saleView(id);
    const at = new Date(s.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    const rows = s.lines.map((l) => `<tr><td>${esc(l.item)}</td><td class="r">${qty(l.qty)} × ${money(l.rate)}</td><td class="r">${money(l.amount)}</td></tr>`).join('');
    const body = `<div class="slip">
<div class="head"><p class="name">${esc(s.school?.legalName)}</p><p>${esc([s.school?.addressLine1, s.school?.city].filter(Boolean).join(', '))}</p><p class="kind">${s.payAt === 'fees' ? 'Store slip (added to fees)' : 'Store receipt'}</p>${s.status === 'cancelled' ? '<p class="cancel">CANCELLED</p>' : ''}</div>
<p>No. ${esc(s.number)} · ${esc(at)}<br>${esc(s.student)} (${esc(s.admissionNo)})</p>
<table><tbody>${rows}<tr class="total"><td colspan="2">Total</td><td class="r">${money(s.total)}</td></tr></tbody></table>
<p>${s.payAt === 'fees' ? 'This amount is added to the student’s fees (next instalment).' : `Paid${s.mode ? ` by ${esc(s.mode)}` : ''}.`}</p>
<p class="by">${esc(s.soldByName)}</p>
</div>`;
    const css = `.slip { font-family: Arial, sans-serif; font-size: 12px; color: #111; }
.head { text-align: center; border-bottom: 1px dashed #333; padding-bottom: 6px; } .head p { margin: 0; } .name { font-weight: 800; font-size: 15px; } .kind { font-weight: 700; margin-top: 4px !important; } .cancel { color: #c00; font-weight: 800; letter-spacing: 2px; }
table { width: 100%; border-collapse: collapse; } td { padding: 2px 0; } .r { text-align: right; } .total td { border-top: 1px dashed #333; font-weight: 800; }
.by { text-align: right; margin-top: 24px; }`;
    const paper = { size: 'A5' as const, orientation: 'portrait' as const, margin: 10 };
    return { fileName: `${s.number}.pdf`, pdf: await htmlToPdf(pageHtml(body, css, paper), paper) };
};
