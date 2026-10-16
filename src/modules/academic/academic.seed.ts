import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { createYear, suggestYear } from './years.service';

/**
 * Starter academic set-up for a new school (KV pattern, CBSE): the current academic year,
 * Bal Vatika 1–3 and Classes I–XII, sections A and B (XI–XII: A Science, B Commerce, C Humanities),
 * common CBSE subjects and the subjects of each class. Schools edit all of it. Runs only while the
 * school has no classes, so a school's own set-up is never touched. Needs the master lists first.
 */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

const CLASSES: { name: string; shortName: string; group: string; hasStreams?: boolean }[] = [
    { name: 'Bal Vatika 1', shortName: 'BV1', group: 'Pre-primary' },
    { name: 'Bal Vatika 2', shortName: 'BV2', group: 'Pre-primary' },
    { name: 'Bal Vatika 3', shortName: 'BV3', group: 'Pre-primary' },
    ...ROMAN.map((r, i) => ({
        name: `Class ${r}`,
        shortName: r,
        group: i < 5 ? 'Primary' : i < 8 ? 'Middle' : i < 10 ? 'Secondary' : 'Senior Secondary',
        hasStreams: i >= 10,
    })),
];

// [name, code, type, co-scholastic?]
const SUBJECTS: [string, string, string, boolean?][] = [
    ['English', 'ENG', 'Language'],
    ['Hindi', 'HIN', 'Language'],
    ['Sanskrit', 'SKT', 'Language'],
    ['Mathematics', 'MAT', 'Theory'],
    ['Environmental Studies', 'EVS', 'Theory'],
    ['Science', 'SCI', 'Theory + practical'],
    ['Social Science', 'SST', 'Theory'],
    ['Artificial Intelligence', 'AI', 'Theory + practical'],
    ['Physics', 'PHY', 'Theory + practical'],
    ['Chemistry', 'CHE', 'Theory + practical'],
    ['Biology', 'BIO', 'Theory + practical'],
    ['Computer Science', 'CS', 'Theory + practical'],
    ['Informatics Practices', 'IP', 'Theory + practical'],
    ['Accountancy', 'ACC', 'Theory'],
    ['Business Studies', 'BST', 'Theory'],
    ['Economics', 'ECO', 'Theory'],
    ['History', 'HIS', 'Theory'],
    ['Geography', 'GEO', 'Theory + practical'],
    ['Political Science', 'POL', 'Theory'],
    ['Physical Education', 'PED', 'Theory + practical'],
    ['Art Education', 'ART', 'Activity', true],
    ['Work Education', 'WE', 'Activity', true],
    ['Health & Physical Education', 'HPE', 'Activity', true],
];

/** Subject codes per class; "?" marks optional ones. Streams: per stream, plus the common list. */
const CO = ['ART', 'WE', 'HPE'];
const PLAN: Record<string, { common: string[]; streams?: Record<string, string[]> }> = {
    BV1: { common: ['ENG', 'HIN', 'MAT', 'ART'] },
    BV2: { common: ['ENG', 'HIN', 'MAT', 'ART'] },
    BV3: { common: ['ENG', 'HIN', 'MAT', 'ART'] },
    I: { common: ['ENG', 'HIN', 'MAT', 'ART', 'HPE'] },
    II: { common: ['ENG', 'HIN', 'MAT', 'ART', 'HPE'] },
    III: { common: ['ENG', 'HIN', 'MAT', 'EVS', ...CO] },
    IV: { common: ['ENG', 'HIN', 'MAT', 'EVS', ...CO] },
    V: { common: ['ENG', 'HIN', 'MAT', 'EVS', ...CO] },
    VI: { common: ['ENG', 'HIN', 'SKT', 'MAT', 'SCI', 'SST', ...CO] },
    VII: { common: ['ENG', 'HIN', 'SKT', 'MAT', 'SCI', 'SST', ...CO] },
    VIII: { common: ['ENG', 'HIN', 'SKT', 'MAT', 'SCI', 'SST', ...CO] },
    IX: { common: ['ENG', 'HIN?', 'SKT?', 'MAT', 'SCI', 'SST', 'AI?', ...CO] },
    X: { common: ['ENG', 'HIN?', 'SKT?', 'MAT', 'SCI', 'SST', 'AI?', ...CO] },
    ...Object.fromEntries(
        ['XI', 'XII'].map((c) => [
            c,
            {
                common: ['ENG', 'WE', 'HPE'],
                streams: {
                    Science: ['PHY', 'CHE', 'MAT?', 'BIO?', 'CS?', 'PED?'],
                    Commerce: ['ACC', 'BST', 'ECO', 'MAT?', 'IP?', 'PED?'],
                    Humanities: ['HIS', 'GEO', 'POL', 'ECO?', 'HIN?', 'PED?'],
                },
            },
        ])
    ),
};

export const seedAcademic = async () => {
    if (await db.schoolClass.count()) return {};
    const tenantId = getTenantId()!;
    const masters = await db.masterValue.findMany({ where: { master: { in: ['class_group', 'stream', 'subject_type'] } }, select: { id: true, name: true, master: true } });
    const master = (list: string, name: string) => masters.find((m) => m.master === list && m.name === name)?.id ?? null;

    const year = (await db.academicYear.findFirst({ where: { isCurrent: true } })) ?? (await createYear({ ...(await suggestYear()), isCurrent: true }));

    await db.schoolClass.createMany({
        data: CLASSES.map((c, i) => ({ tenantId, name: c.name, shortName: c.shortName, groupId: master('class_group', c.group), hasStreams: c.hasStreams ?? false, sortOrder: (i + 1) * 10 })),
    });
    const classes = await db.schoolClass.findMany({ select: { id: true, shortName: true, hasStreams: true } });

    if (!(await db.subject.count())) {
        await db.subject.createMany({
            data: SUBJECTS.map(([name, code, type, co], i) => ({ tenantId, name, code, typeId: master('subject_type', type), assessment: co ? ('co_scholastic' as const) : ('scholastic' as const), sortOrder: (i + 1) * 10 })),
        });
    }
    const subjects = new Map((await db.subject.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]));

    const sections: { tenantId: string; academicYearId: string; classId: string; name: string; streamId: string | null; sortOrder: number }[] = [];
    const links: { tenantId: string; academicYearId: string; classId: string; streamId: string | null; subjectId: string; isOptional: boolean; sortOrder: number }[] = [];
    const addLinks = (classId: string, streamId: string | null, codes: string[]) =>
        codes.forEach((c, i) => {
            const subjectId = subjects.get(c.replace('?', ''));
            if (subjectId) links.push({ tenantId, academicYearId: year.id, classId, streamId, subjectId, isOptional: c.endsWith('?'), sortOrder: (i + 1) * 10 });
        });

    for (const c of classes) {
        const plan = PLAN[c.shortName ?? ''];
        if (c.hasStreams) {
            ['Science', 'Commerce', 'Humanities'].forEach((stream, i) =>
                sections.push({ tenantId, academicYearId: year.id, classId: c.id, name: String.fromCharCode(65 + i), streamId: master('stream', stream), sortOrder: (i + 1) * 10 })
            );
        } else {
            ['A', 'B'].forEach((name, i) => sections.push({ tenantId, academicYearId: year.id, classId: c.id, name, streamId: null, sortOrder: (i + 1) * 10 }));
        }
        if (!plan) continue;
        addLinks(c.id, null, plan.common);
        for (const [stream, codes] of Object.entries(plan.streams ?? {})) {
            const streamId = master('stream', stream);
            if (streamId) addLinks(c.id, streamId, codes);
        }
    }
    // A stream the school renamed before this ran is skipped (a stream class's section needs one).
    const streamClasses = new Set(classes.filter((c) => c.hasStreams).map((c) => c.id));
    await db.section.createMany({ data: sections.filter((s) => s.streamId || !streamClasses.has(s.classId)) });
    await db.classSubject.createMany({ data: links, skipDuplicates: true });
    return { year: year.name, classes: classes.length, sections: sections.length, subjects: subjects.size, classSubjects: links.length };
};
