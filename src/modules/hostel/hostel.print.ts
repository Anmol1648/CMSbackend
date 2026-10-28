import { db } from '../../core/db';
import { htmlToPdf, htmlToPng, pageHtml } from '../../core/pdf';
import { esc, imageData, qrSvg } from '../../core/pdf/codes';
import { passSlip } from './hostel.service';

/**
 * The hostel leave pass, as on the website: the school, the boarder's photo and details, the leave,
 * and the pass code as a QR the gate scans going out and coming back. A5 PDF to print, or a picture
 * for the phone's screen.
 */

const A5 = { size: 'A5' as const, orientation: 'portrait' as const, margin: 10 };

const when = (d: Date | string | null) =>
    d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—';

const slipHtml = async (leaveId: string, userId: string) => {
    const p = await passSlip(leaveId, userId);
    const student = await db.student.findFirst({ where: { id: p.studentId }, select: { photoFileId: true } });
    const [photo, qr] = await Promise.all([imageData(student?.photoFileId), qrSvg(p.passCode ?? '')]);
    const row = (label: string, value: string | null | undefined) => (value ? `<tr><td class="k">${esc(label)}</td><td class="v">${esc(value)}</td></tr>` : '');
    const body = `<div class="slip">
<div class="head"><p class="school">${esc(p.school?.legalName)}</p><p class="addr">${esc([p.school?.addressLine1, p.school?.city].filter(Boolean).join(', '))}</p><p class="title">HOSTEL LEAVE PASS</p></div>
<div class="who">${photo ? `<img class="photo" src="${photo}">` : '<div class="photo none"></div>'}<table>${row('Name', p.student)}${row('Adm. no.', p.admissionNo)}${row('Class', p.section)}${row('Hostel', `${p.hostel}${p.room ? `, room ${p.room}${p.bed ? ` / bed ${p.bed}` : ''}` : ''}`)}</table></div>
<table class="leave">${row('Leaves', when(p.fromAt))}${row('Back by', when(p.toAt))}${row('Reason', p.reason)}${row('With', p.escort)}${row('Going to', p.destination)}${row('Approved by', p.answeredBy || p.warden || '—')}</table>
<div class="foot"><div class="code"><div class="qr">${qr}</div><p class="pass">${esc(p.passCode)}</p></div>
<div class="note">Show this pass at the hostel gate when leaving and when coming back.${p.hostelPhone ? `<p>Hostel phone: ${esc(p.hostelPhone)}</p>` : ''}<p class="sign">Warden’s signature</p></div></div>
</div>`;
    const css = `.slip { border: 2px solid #1A365D; border-radius: 12px; padding: 16px; font-size: 13px; background: #fff; }
.head { text-align: center; border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 12px; } .head p { margin: 0; }
.school { font-weight: 800; font-size: 16px; } .addr { font-size: 11px; } .title { margin-top: 6px !important; font-weight: 800; letter-spacing: 2px; font-size: 14px; }
.who { display: flex; gap: 14px; } .photo { width: 20mm; height: 25mm; object-fit: cover; border-radius: 6px; flex: none; } .photo.none { background: #f0f0f0; }
table { border-collapse: collapse; flex: 1; } .leave { width: 100%; margin-top: 12px; }
.k { padding: 3px 8px 3px 0; color: #555; white-space: nowrap; vertical-align: top; } .v { padding: 3px 0; font-weight: 600; }
.foot { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; gap: 12px; }
.code { text-align: center; } .qr svg { width: 30mm; height: 30mm; display: block; margin: 0 auto; } .pass { font-family: monospace; font-weight: 800; font-size: 18px; letter-spacing: 3px; margin: 4px 0 0; }
.note { flex: 1; font-size: 11px; color: #444; } .note p { margin: 4px 0 0; } .sign { margin-top: 28px !important; border-top: 1px solid #888; padding-top: 2px; text-align: center; }`;
    return { code: p.passCode ?? leaveId, body, css };
};

/** The pass on A5, to print. */
export const passPdf = async (leaveId: string, userId: string) => {
    const s = await slipHtml(leaveId, userId);
    return { fileName: `leave-pass-${s.code}.pdf`, pdf: await htmlToPdf(pageHtml(s.body, s.css, A5), A5) };
};

/** The pass as a picture, to show on the phone at the gate. */
export const passPng = async (leaveId: string, userId: string) => {
    const s = await slipHtml(leaveId, userId);
    const html = pageHtml(`<div class="wrap">${s.body}</div>`, `${s.css} .wrap { padding: 3mm; width: 128mm; }`, A5);
    return htmlToPng(html, { widthMm: 134, heightMm: 150 }, 3);
};
