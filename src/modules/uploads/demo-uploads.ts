import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { saveUpload } from '../../core/files';
import { seedMasters } from '../masters/masters.service';
import { currentYear } from '../academic/years.service';
import { dayDate, isoOf, todayIST } from '../attendance/attendance.settings';

/**
 * Demo shared files: Circulars, Syllabus (one PDF per class, seen by that class and its parents,
 * plus a link), Exam timetable, Forms, Holiday homework (Deepak Rautela's for VII-B; teachers add
 * here) and a Staff only policy to acknowledge (some staff have). The PDFs are made here so they open.
 * Marked is_demo.
 */

let seed = 4_444;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;

/** A small one-page PDF with a title and some lines (Helvetica, no images). */
const makePdf = (title: string, lines: string[]) => {
    const esc = (t: string) => t.replace(/[^\x20-\x7E]/g, '-').replace(/([()\\])/g, '\\$1');
    const body = [`BT /F1 20 Tf 60 780 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 12 Tf 60 ${740 - i * 20} Td (${esc(l)}) Tj ET`)].join('\n');
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
};

export const createDemoUploads = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.uploadFolder.count({ where: { isDemo: true } }))) return { folders: 0, files: 0 };
    await seedMasters();
    const tags = await db.masterValue.findMany({ where: { master: 'upload_tag' }, select: { id: true, name: true } });
    const tag = (n: string) => tags.filter((t) => t.name === n).map((t) => t.id);
    const admin = await db.user.findFirst({ where: { isDemo: true, roles: { some: { role: { slug: { in: ['office-staff', 'school-admin'] } } } } }, select: { id: true } });
    const today = todayIST();
    let files = 0;

    const folder = async (name: string, o: { description?: string; audience?: string; staffAdd?: boolean; sort: number }) =>
        db.uploadFolder.create({ data: { tenantId, name, description: o.description ?? null, inherit: !o.audience, audience: o.audience ?? 'everyone', staffAdd: !!o.staffAdd, sortOrder: o.sort, createdBy: admin?.id ?? null, isDemo: true } });
    const pdf = async (folderId: string, title: string, lines: string[], o: { tags?: string[]; sections?: string[]; daysAgo?: number; ack?: boolean; by?: string | null; validDays?: number } = {}) => {
        const f = await saveUpload({ data: makePdf(title, lines), originalName: `${title.replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-')}.pdf`, purpose: 'upload', allowed: ['pdf'] });
        const at = new Date(Date.now() - (o.daysAgo ?? Math.floor(rand() * 40)) * DAY);
        const custom = !!o.sections?.length;
        const item = await db.uploadItem.create({ data: { tenantId, folderId, title, kind: 'file', fileId: f.id, fileName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, tagIds: (o.tags ?? []).flatMap(tag), inherit: !custom, audience: custom ? 'custom' : 'everyone', sectionIds: o.sections ?? [], withParents: true, needsAck: !!o.ack, validUntil: o.validDays ? dayDate(isoOf(new Date(dayDate(today).getTime() + o.validDays * DAY))) : null, uploadedBy: o.by ?? admin?.id ?? null, createdAt: at, updatedAt: at, isDemo: true } });
        files++;
        return item;
    };

    const circ = await folder('Circulars', { description: 'Notices sent home', sort: 10 });
    await pdf(circ.id, 'Winter vacation circular', ['The school remains closed for winter vacation', 'from 25 December to 10 January.', 'Holiday homework is on Downloads > Holiday homework.'], { tags: ['Circular'], daysAgo: 2 });
    await pdf(circ.id, 'Annual day invitation', ['Parents are invited to the Annual Day', 'on Saturday at 10:00 am in the school ground.'], { tags: ['Circular'], daysAgo: 12, validDays: 20 });
    await pdf(circ.id, 'Uniform guidelines', ['Winter uniform from 1 November.', 'Blue sweater, grey trousers / skirt, black shoes.'], { tags: ['Circular', 'Policy'], daysAgo: 30 });

    const syl = await folder('Syllabus', { description: 'Syllabus of each class for this session', sort: 20 });
    const sections = await db.section.findMany({ where: { academicYearId: year.id }, select: { id: true, classId: true, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } }, orderBy: { schoolClass: { sortOrder: 'asc' } } });
    const classes = [...new Map(sections.map((s) => [s.classId, s.schoolClass])).entries()].filter(([, c]) => ['VI', 'VII', 'VIII', 'IX', 'X'].includes(c.shortName ?? ''));
    for (const [classId, c] of classes) await pdf(syl.id, `${c.name} syllabus ${year.name}`, ['English, Hindi, Mathematics, Science, Social Science, Sanskrit.', 'Term 1: chapters 1-6. Term 2: chapters 7-12.', 'Unit tests in July and November; exams in September and March.'], { tags: ['Syllabus'], sections: sections.filter((s) => s.classId === classId).map((s) => s.id), daysAgo: 60 });
    await db.uploadItem.create({ data: { tenantId, folderId: syl.id, title: 'NCERT textbooks (read online)', description: 'All NCERT books, free, on the NCERT website.', kind: 'link', link: 'https://ncert.nic.in/textbook.php', tagIds: tag('Notes'), uploadedBy: admin?.id ?? null, isDemo: true } });
    files++;

    const exam = await folder('Exam timetable', { sort: 30 });
    await pdf(exam.id, 'Half-yearly exam timetable', ['Classes VI-X: 15 to 24 September, 9:00 am to 12:00 noon.', 'Classes XI-XII: 14 to 25 September.'], { tags: ['Timetable'], daysAgo: 20 });

    const forms = await folder('Forms', { description: 'Print, fill and give at the office', sort: 40 });
    for (const t of ['Transport application form', 'Student leave application', 'TC request form', 'Change of address form']) await pdf(forms.id, t, ['Name of student: ____________   Class: _____', 'Parent signature: ____________   Date: _____'], { tags: ['Form'], daysAgo: 50 + Math.floor(rand() * 30) });

    const hw = await folder('Holiday homework', { description: 'Teachers add their sections’ homework here', staffAdd: true, sort: 50 });
    const deepak = await db.staff.findFirst({ where: { firstName: 'Deepak', lastName: 'Rautela' }, select: { userId: true } });
    const vii = await db.section.findFirst({ where: { academicYearId: year.id, name: 'B', schoolClass: { shortName: 'VII' } }, select: { id: true } });
    if (vii) await pdf(hw.id, 'VII-B Hindi holiday homework', ['Read the chapters 8-10 and write a summary of each.', 'Write a letter to your friend about your vacation.', '- Deepak Rautela'], { tags: ['Holiday homework'], sections: [vii.id], by: deepak?.userId ?? null, daysAgo: 1 });

    const staffOnly = await folder('Staff only', { audience: 'staff', sort: 60 });
    const policy = await pdf(staffOnly.id, 'Staff code of conduct 2026', ['Punctuality: be in school by 7:45 am.', 'Mobile phones on silent in class.', 'Child safety: never be alone with a child behind a closed door.', 'Please acknowledge that you have read this.'], { tags: ['Policy'], ack: true, daysAgo: 6 });
    await pdf(staffOnly.id, 'Duty roster: November', ['Gate duty, assembly duty and bus duty for November.'], { tags: ['Timetable'], daysAgo: 4 });
    const staff = await db.user.findMany({ where: { isDemo: true, kind: 'staff', status: 'active' }, select: { id: true }, take: 40 });
    const acked = staff.filter(() => rand() < 0.55);
    if (acked.length) await db.uploadView.createMany({ data: acked.map((u) => ({ tenantId, itemId: policy.id, userId: u.id, opens: 1, acknowledgedAt: new Date(Date.now() - Math.floor(rand() * 5) * DAY), isDemo: true })), skipDuplicates: true });
    return { folders: 6, files };
};

export const clearDemoUploads = async () => {
    await db.uploadFolder.deleteMany({ where: { isDemo: true } });
};
