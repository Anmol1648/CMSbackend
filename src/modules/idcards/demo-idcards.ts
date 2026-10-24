import { deflateSync } from 'zlib';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { saveUpload } from '../../core/files';
import { getSettings } from '../../core/settings';
import { takeNumbers } from '../../core/numbering';
import { currentYear } from '../academic/years.service';
import { IDCARDS } from './idcards.settings';

/**
 * Demo ID cards: three designs (student portrait, student landscape, staff), silhouette photos for
 * VII-B (3 left without, to show the warning) and the staff with logins, cards printed for VII-B
 * and the staff, a duplicate for Shubham Nautiyal (lost, ₹100), and one photo sent by a parent
 * waiting for approval. Marked is_demo.
 */

// ─── A small PNG silhouette (no image library) ───────────────────────────────

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
};
/** A passport-style silhouette on a coloured background (240 × 300). */
const silhouette = (bg: [number, number, number], shirt: [number, number, number]) => {
    const w = 240;
    const h = 300;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const head = (x - 120) ** 2 / 52 ** 2 + (y - 120) ** 2 / 62 ** 2 <= 1;
            const body = y > 200 && (x - 120) ** 2 / 110 ** 2 + (y - 320) ** 2 / 120 ** 2 <= 1;
            const neck = y > 170 && y < 215 && Math.abs(x - 120) < 24;
            const c: [number, number, number] = head || neck ? [222, 184, 150] : body ? shirt : bg;
            const o = y * (w * 3 + 1) + 1 + x * 3;
            raw[o] = c[0];
            raw[o + 1] = c[1];
            raw[o + 2] = c[2];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const BGS: [number, number, number][] = [[200, 222, 245], [230, 236, 242], [214, 234, 222], [240, 228, 210]];
const SHIRTS: [number, number, number][] = [[255, 255, 255], [40, 70, 120], [120, 30, 40], [60, 90, 60]];

export const createDemoIdCards = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.idCardDesign.count({ where: { isDemo: true } }))) return { designs: 0, cards: 0, photos: 0 };
    if (!(await db.masterValue.findFirst({ where: { master: 'fee_head', code: 'IDC' } }))) await db.masterValue.create({ data: { tenantId, master: 'fee_head', name: 'ID card (duplicate)', code: 'IDC', sortOrder: 99, extra: { one_time: true, refundable: false } } });

    const student = await db.idCardDesign.create({ data: { tenantId, name: 'Student card (portrait)', kind: 'student', orientation: 'portrait', color: '#1A365D', textColor: '#FFFFFF', fields: ['photo', 'name', 'class', 'admissionNo', 'dob', 'bloodGroup', 'father', 'phone', 'transport', 'validUntil'], code: 'qr', back: true, backFields: ['address', 'emergency', 'schoolAddress'], backText: 'If found, please return to the school office.\nThis card must be carried every day and shown on request.', signatureLabel: 'Principal', isDefault: true, isDemo: true } });
    await db.idCardDesign.create({ data: { tenantId, name: 'Student card (landscape, maroon)', kind: 'student', orientation: 'landscape', color: '#7B1E2B', textColor: '#FFFFFF', fields: ['photo', 'name', 'class', 'rollNo', 'admissionNo', 'bloodGroup', 'house', 'validUntil'], code: 'barcode', back: true, backFields: ['father', 'mother', 'phone', 'address', 'schoolAddress'], backText: 'If found, please return to the school.', signatureLabel: 'Principal', isDemo: true } });
    const staffDesign = await db.idCardDesign.create({ data: { tenantId, name: 'Staff card', kind: 'staff', orientation: 'portrait', color: '#0F5132', textColor: '#FFFFFF', fields: ['photo', 'name', 'designation', 'department', 'employeeCode', 'bloodGroup', 'phone', 'validUntil'], code: 'qr', back: true, backFields: ['emergency', 'address', 'schoolAddress'], backText: 'This card is the property of the school. If found, please return it to the office.', signatureLabel: 'Principal', isDefault: true, isDemo: true } });

    // Photos: VII-B (all but the last 3) and staff with logins.
    const deepak = await db.staff.findFirst({ where: { user: { username: 'deepak.rautela' } }, select: { id: true } });
    const section = deepak ? await db.section.findFirst({ where: { academicYearId: year.id, classTeacherId: deepak.id }, select: { id: true } }) : null;
    const enrol = section ? await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: section.id, student: { status: 'active' } }, orderBy: { rollNumber: 'asc' }, select: { studentId: true, student: { select: { photoFileId: true, admissionNo: true } } } }) : [];
    const staff = await db.staff.findMany({ where: { status: 'working', userId: { not: null } }, select: { id: true, photoFileId: true } });
    let photos = 0;
    const png = async (i: number) => (await saveUpload({ data: silhouette(BGS[i % BGS.length], SHIRTS[i % SHIRTS.length]), originalName: `photo-${i}.png`, purpose: 'avatar', allowed: ['png'] })).id;
    for (const [i, e] of enrol.slice(0, Math.max(0, enrol.length - 3)).entries()) {
        if (e.student.photoFileId) continue;
        await db.student.update({ where: { id: e.studentId }, data: { photoFileId: await png(i) } });
        photos++;
    }
    for (const [i, s] of staff.entries()) {
        if (s.photoFileId) continue;
        await db.staff.update({ where: { id: s.id }, data: { photoFileId: await png(i + 1) } });
        photos++;
    }

    // Cards printed for VII-B and staff, some weeks ago.
    const s = await getSettings({ p: IDCARDS.prefix, d: IDCARDS.digits });
    const no = async () => `${s.p}${String(await takeNumbers('id_card', 1)).padStart(s.d, '0')}`;
    const office = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: 'office-staff' } } } }, select: { id: true } });
    const at = new Date(Date.now() - 40 * 86_400_000);
    const staffUntil = new Date(at);
    staffUntil.setUTCMonth(staffUntil.getUTCMonth() + 12);
    let cards = 0;
    for (const e of enrol.slice(0, Math.max(0, enrol.length - 3))) {
        await db.idCard.create({ data: { tenantId, cardNo: await no(), designId: student.id, holderType: 'student', studentId: e.studentId, academicYearId: year.id, validUntil: year.endDate, printCount: 1, lastPrintedAt: at, issuedBy: office?.id ?? null, isDemo: true, createdAt: at } });
        cards++;
    }
    for (const x of staff) {
        await db.idCard.create({ data: { tenantId, cardNo: await no(), designId: staffDesign.id, holderType: 'staff', staffId: x.id, academicYearId: year.id, validUntil: staffUntil, printCount: 1, lastPrintedAt: at, issuedBy: office?.id ?? null, isDemo: true, createdAt: at } });
        cards++;
    }

    // Shubham lost his card: replaced (₹100 in his fees).
    const shubham = await db.student.findFirst({ where: { OR: [{ admissionNo: '2025/0235' }, { user: { username: '20250235' } }] }, select: { id: true } });
    const old = shubham ? await db.idCard.findFirst({ where: { studentId: shubham.id, status: 'active' } }) : null;
    if (old) {
        const when = new Date(Date.now() - 6 * 86_400_000);
        await db.idCard.update({ where: { id: old.id }, data: { status: 'replaced', replacedAt: when } });
        await db.idCard.create({ data: { tenantId, cardNo: await no(), designId: student.id, holderType: 'student', studentId: old.studentId, academicYearId: year.id, validUntil: year.endDate, reason: 'lost', fee: 100, printCount: 1, lastPrintedAt: when, issuedBy: office?.id ?? null, isDemo: true, createdAt: when } });
        cards++;
    }

    // A parent sent a photo for one of the students without one.
    const waiting = enrol[enrol.length - 1];
    if (waiting) {
        const parent = await db.guardian.findFirst({ where: { userId: { not: null }, family: { students: { some: { id: waiting.studentId } } } }, select: { userId: true } });
        await db.idPhotoRequest.create({ data: { tenantId, studentId: waiting.studentId, fileId: await png(7), uploadedBy: parent?.userId ?? null, isDemo: true } });
    }
    return { designs: 3, cards, photos };
};

export const clearDemoIdCards = async () => {
    await db.idPhotoRequest.deleteMany({ where: { isDemo: true } });
    await db.idCard.deleteMany({ where: { isDemo: true } });
    await db.idCardDesign.deleteMany({ where: { isDemo: true, cards: { none: {} } } });
};
