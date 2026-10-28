import { db } from '../../core/db';
import { htmlToPdf, pageHtml } from '../../core/pdf';
import { esc, imageData, qrSvg } from '../../core/pdf/codes';
import { pass, visitPhoto } from './visitors.service';

/** The visitor pass as a PDF (an A6 card or an 80 mm roll, as set in System Settings → Visitors), printed from the app or the website. */
export const passPdf = async (visitId: string) => {
    const [p, photoId, school] = await Promise.all([pass(visitId), visitPhoto(visitId), db.schoolProfile.findFirst({ select: { logoFileId: true } })]);
    const v = p.visit;
    const [photo, logo, qr] = await Promise.all([imageData(photoId), imageData(school?.logoFileId), v.passNo ? qrSvg(v.passNo) : Promise.resolve('')]);
    const inAt = v.inAt ? new Date(v.inAt) : new Date();
    const when = `${inAt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}, ${inAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })}`;
    const line = (k: string, x: string | number | null | undefined) => (x ? `<p><b>${k}:</b> ${esc(x)}</p>` : '');
    const body = `<div class="pass">
<div class="head">${logo ? `<img class="logo" src="${logo}">` : ''}<div><p class="school">${esc(p.school.name)}</p><p class="title">VISITOR PASS</p></div></div>
<div class="mid">${photo ? `<img class="photo" src="${photo}">` : '<div class="photo none"></div>'}<div class="who">
<p class="name">${esc(v.visitor.name)}</p>${v.visitor.mobile ? `<p>${esc(v.visitor.mobile)}</p>` : ''}${line('To meet', v.host)}${line('For', v.purpose)}${v.people > 1 ? line('People', v.people) : ''}${line('Vehicle', v.vehicleNo)}
</div></div>
<div class="foot"><div><p class="no">${esc(v.passNo)}</p><p>In: ${esc(when)}</p><p class="small">Valid today only. Return the pass at the gate.</p></div><div class="qr">${qr}</div></div>
</div>`;
    const css = `.pass { font-size: 11px; }
.head { display: flex; align-items: center; gap: 8px; justify-content: center; text-align: center; border-bottom: 1px dashed #999; padding-bottom: 6px; }
.logo { height: 28px; } .school { font-size: 13px; font-weight: 800; text-transform: uppercase; margin: 0; } .title { font-size: 10px; font-weight: 700; letter-spacing: 3px; margin: 0; }
.mid { display: flex; gap: 10px; padding: 10px 0; } .photo { width: 22mm; height: 28mm; object-fit: cover; border: 1px solid #ccc; border-radius: 3px; flex: none; } .photo.none { background: #f2f2f2; }
.who p { margin: 0 0 2px; } .name { font-size: 15px; font-weight: 800; }
.foot { display: flex; justify-content: space-between; align-items: flex-end; border-top: 1px dashed #999; padding-top: 6px; } .foot p { margin: 0; } .no { font-size: 14px; font-weight: 800; } .small { font-size: 8px; margin-top: 3px !important; }
.qr svg { width: 20mm; height: 20mm; }`;
    const paper = { size: p.size === 'thermal' ? ('THERMAL_80' as const) : ('A6' as const), orientation: 'portrait' as const, margin: 4 };
    return { fileName: `pass-${v.passNo ?? v.id}.pdf`, pdf: await htmlToPdf(pageHtml(body, css, paper), paper) };
};
