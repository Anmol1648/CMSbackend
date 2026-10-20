import { randomUUID } from 'crypto';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { formatNumber, takeNumbers } from '../../core/numbering';
import { STAFF } from './staff.settings';

/**
 * Demo staff for a KV-style school: principal and office, PRTs for Bal Vatika–V (each the class
 * teacher and teacher of their own section), TGTs for VI–X and PGTs for XI–XII by subject, and
 * support staff. Every section gets a class teacher and a teacher for each of its subjects.
 * Teaching staff (and the office) get logins with the demo password; drivers and sub-staff don't.
 */

interface SectionRow {
    id: string;
    classId: string;
    streamId: string | null;
    schoolClass: { sortOrder: number; shortName: string | null };
    stream: { name: string } | null;
}

type Rand = { pick: <T>(l: readonly T[]) => T; between: (lo: number, hi: number) => number };

const FIRST_M = ['Rajesh', 'Manoj', 'Deepak', 'Sanjay', 'Vinod', 'Harish', 'Pankaj', 'Rakesh', 'Girish', 'Naveen', 'Sandeep', 'Mukesh', 'Alok', 'Vikram', 'Ravindra', 'Hemant', 'Ajay', 'Pradeep', 'Kuldeep', 'Dinesh', 'Yogesh', 'Arvind'];
const FIRST_F = ['Anita', 'Sunita', 'Kavita', 'Pooja', 'Rekha', 'Meena', 'Asha', 'Neelam', 'Seema', 'Usha', 'Priyanka', 'Geeta', 'Renu', 'Shalini', 'Archana', 'Jyoti', 'Nisha', 'Pallavi', 'Mamta', 'Sarita', 'Deepa', 'Kiran'];
const LAST = ['Negi', 'Rawat', 'Bisht', 'Joshi', 'Semwal', 'Thapliyal', 'Nautiyal', 'Chauhan', 'Rana', 'Butola', 'Kandari', 'Dimri', 'Sati', 'Bhatt', 'Gairola', 'Raturi', 'Uniyal', 'Pant', 'Kandpal', 'Rautela', 'Martolia', 'Farswan', 'Pundir', 'Mamgain', 'Sharma', 'Verma', 'Gupta', 'Singh', 'Bhandari', 'Panwar'];

/** Subject teachers of VI–X (two each) and XI–XII (one each), by subject code. */
const TGT = ['ENG', 'ENG', 'HIN', 'HIN', 'SKT', 'MAT', 'MAT', 'SCI', 'SCI', 'SST', 'SST', 'AI'];
const PGT = ['ENG', 'PHY', 'CHE', 'MAT', 'BIO', 'CS', 'ACC', 'BST', 'ECO', 'HIS', 'GEO', 'POL', 'HIN'];
/** Who leads a stream section of XI–XII as class teacher. */
const STREAM_LEAD: Record<string, string> = { Science: 'PHY', Commerce: 'ACC', Humanities: 'HIS' };
const OFFICE: [string, string | null, boolean][] = [
    ['Principal', 'school-admin', true],
    ['Vice Principal', 'principal', true],
    ['Administrative Officer', 'school-admin', false],
    ['Accountant', 'accountant', false],
    ['Senior Secretariat Assistant', 'office-staff', false],
    ['Junior Secretariat Assistant', 'office-staff', false],
    ['Librarian', 'teacher', false],
    ['Lab Assistant', null, false],
    ['Driver', null, false],
    ['Driver', null, false],
    ['Sub Staff (MTS)', null, false],
    ['Sub Staff (MTS)', null, false],
    ['Security Guard', null, false],
];

export const createDemoStaff = async (yearId: string, yearStart: number, sections: SectionRow[], passwordHash: string, rand: Rand, uniqueName: (b: string) => string) => {
    const tenantId = getTenantId()!;
    const masters = await db.masterValue.findMany({ where: { master: { in: ['department', 'designation', 'staff_type', 'employment_type', 'teaching_post', 'gender', 'qualification', 'marital_status', 'bank'] } }, select: { id: true, name: true, master: true, extra: true } });
    const m = (master: string, name: string) => masters.find((x) => x.master === master && x.name === name)?.id ?? null;
    const subjects = new Map((await db.subject.findMany({ select: { id: true, code: true } })).map((s) => [s.code ?? '', s.id]));
    const classSubjects = await db.classSubject.findMany({ where: { academicYearId: yearId }, select: { classId: true, streamId: true, subjectId: true } });
    const roles = new Map((await db.role.findMany({ select: { id: true, slug: true } })).map((r) => [r.slug, r.id]));
    const { pattern, start, loginDefault } = await getSettings({ pattern: STAFF.codePattern, start: STAFF.codeStart, loginDefault: STAFF.loginDefault });
    const banks = masters.filter((x) => x.master === 'bank' && (x.extra as { ifscPrefix?: string }).ifscPrefix);
    const dept: Record<string, string> = { ENG: 'Languages', HIN: 'Languages', SKT: 'Languages', MAT: 'Mathematics', SCI: 'Science', PHY: 'Science', CHE: 'Science', BIO: 'Science', SST: 'Social Science', HIS: 'Social Science', GEO: 'Social Science', POL: 'Social Science', ECO: 'Commerce', ACC: 'Commerce', BST: 'Commerce', CS: 'Computer Science', AI: 'Computer Science' };

    interface Person {
        id: string;
        firstName: string;
        lastName: string;
        female: boolean;
        designation: string;
        post: string | null;
        department: string;
        teaching: boolean;
        subjects: string[];
        role: string | null;
        login: boolean;
    }
    const people: Person[] = [];
    const person = (designation: string, post: string | null, department: string, teaching: boolean, subjectCodes: string[], role: string | null, login: boolean) => {
        const female = rand.between(0, 1) === 1;
        const p = { id: randomUUID(), firstName: rand.pick(female ? FIRST_F : FIRST_M), lastName: rand.pick(LAST), female, designation, post, department, teaching, subjects: subjectCodes, role, login };
        people.push(p);
        return p;
    };

    // Office and support staff.
    for (const [designation, role, teaching] of OFFICE) {
        const office = ['Principal', 'Vice Principal', 'Administrative Officer'].includes(designation);
        const dept = office ? 'Administration' : designation === 'Accountant' ? 'Accounts' : designation === 'Librarian' ? 'Library' : designation === 'Driver' ? 'Transport' : designation.includes('Secretariat') ? 'Administration' : 'Support staff';
        person(designation, null, dept, teaching, [], role, !!role);
    }
    // PRT: one per pre-primary and primary section (classes before VI).
    const primary = sections.filter((s) => s.schoolClass.sortOrder < 90);
    const prt = primary.map((s) => ({ section: s, p: person('PRT', s.schoolClass.sortOrder <= 30 ? 'Balvatika teacher' : 'PRT (Primary Teacher)', 'Primary', true, ['ENG', 'HIN', 'MAT', 'EVS', 'ART', 'HPE', 'WE'], 'teacher', true) }));
    const tgt = TGT.map((code) => person('TGT', 'TGT (Trained Graduate Teacher)', dept[code], true, [code], 'teacher', true));
    const pgt = PGT.map((code) => person('PGT', 'PGT (Post Graduate Teacher)', dept[code], true, [code], 'teacher', true));
    const pe = person('Sports Coach', 'TGT (Trained Graduate Teacher)', 'Physical Education', true, ['HPE', 'PED'], 'teacher', true);
    const art = person('TGT', 'TGT (Trained Graduate Teacher)', 'Arts', true, ['ART', 'WE'], 'teacher', true);
    if (loginDefault === 'none') for (const p of people) p.login = false;
    if (loginDefault === 'all') for (const p of people) p.login = true;

    // Employee codes by the school's pattern, in joining order.
    const first = await takeNumbers('staff', start, people.length);
    const joined = people.map(() => new Date(Date.UTC(yearStart - rand.between(0, 18), rand.between(3, 7), rand.between(1, 28))));
    const codes = people.map((_, i) => formatNumber(pattern, { seq: first + i, date: joined[i] }));
    const userIds = people.map((p) => (p.login ? randomUUID() : null));
    const users = people.flatMap((p, i) =>
        userIds[i] ? [{ id: userIds[i]!, tenantId, kind: 'staff' as const, username: uniqueName(`${p.firstName}.${p.lastName}`.toLowerCase()), displayName: `${p.firstName} ${p.lastName}`, passwordHash, mustChangePassword: false, isDemo: true }] : []
    );
    if (users.length) await db.user.createMany({ data: users });
    const roleRows = people.flatMap((p, i) => {
        if (!userIds[i] || !p.role) return [];
        const slugs = p.role === 'teacher' && p.teaching ? ['teacher', 'class-teacher'] : [p.role];
        return slugs.filter((r) => roles.has(r)).map((r) => ({ tenantId, userId: userIds[i]!, roleId: roles.get(r)! }));
    });
    if (roleRows.length) await db.userRole.createMany({ data: roleRows, skipDuplicates: true });

    const subjectIds = (list: string[]) => list.map((c) => subjects.get(c)).filter((x): x is string => !!x);
    await db.staff.createMany({
        data: people.map((p, i) => {
            const bank = banks.length && p.teaching ? rand.pick(banks) : null;
            return {
                id: p.id,
                tenantId,
                employeeCode: codes[i],
                joiningDate: joined[i],
                firstName: p.firstName,
                lastName: p.lastName,
                dateOfBirth: new Date(Date.UTC(yearStart - rand.between(26, 56), rand.between(0, 11), rand.between(1, 28))),
                genderId: m('gender', p.female ? 'Female' : 'Male'),
                maritalStatusId: m('marital_status', rand.between(0, 4) ? 'Married' : 'Single'),
                mobile: `9${rand.between(100000000, 999999999)}`,
                departmentId: m('department', p.department),
                designationId: m('designation', p.designation),
                staffTypeId: m('staff_type', p.teaching ? 'Teaching' : 'Non-teaching'),
                employmentTypeId: m('employment_type', p.designation === 'Driver' || p.designation === 'Security Guard' ? 'Outsourced' : rand.between(0, 9) ? 'Permanent' : 'Contract'),
                teachingPostId: p.post ? m('teaching_post', p.post) : null,
                teachableSubjectIds: subjectIds(p.subjects),
                bankId: bank?.id ?? null,
                bankAccountNo: bank ? String(rand.between(10000000, 99999999)) + String(rand.between(1000, 9999)) : null,
                ifsc: bank ? `${(bank.extra as { ifscPrefix: string }).ifscPrefix}0${String(rand.between(100000, 999999))}` : null,
                addressLine: `Staff quarters ${rand.between(1, 40)}, KV campus`,
                userId: userIds[i],
                isDemo: true,
            };
        }),
    });
    // Teachers report to the vice principal, the office to the principal.
    const principal = people.find((p) => p.designation === 'Principal')!;
    const vice = people.find((p) => p.designation === 'Vice Principal') ?? principal;
    await db.staff.updateMany({ where: { id: { in: people.filter((p) => p.teaching && p !== principal && p !== vice).map((p) => p.id) } }, data: { reportsToId: vice.id } });
    await db.staff.updateMany({ where: { id: { in: people.filter((p) => !p.teaching).map((p) => p.id) } }, data: { reportsToId: principal.id } });

    const quals = people.filter((p) => p.teaching).flatMap((p, i) => [
        { tenantId, staffId: p.id, qualificationId: m('qualification', p.designation === 'PGT' ? 'Post graduate' : 'Graduate'), subject: p.subjects[0] ?? null, institution: rand.pick(['HNB Garhwal University', 'Kumaun University', 'Doon University', 'Delhi University']), year: yearStart - rand.between(5, 25), sortOrder: 10 + i * 0 },
        { tenantId, staffId: p.id, qualificationId: m('qualification', 'B.Ed'), subject: null, institution: rand.pick(['HNB Garhwal University', 'Kumaun University', 'IGNOU']), year: yearStart - rand.between(3, 20), sortOrder: 20 },
    ]);
    await db.staffQualification.createMany({ data: quals.filter((q) => q.qualificationId) });

    // Class teachers and subject teachers.
    const codeOf = new Map([...subjects.entries()].map(([code, id]) => [id, code]));
    const subjectTeacher = (pool: Person[], code: string, n: number) => {
        const able = pool.filter((p) => p.subjects.includes(code));
        return able.length ? able[n % able.length] : null;
    };
    const assignments: { tenantId: string; academicYearId: string; sectionId: string; subjectId: string; staffId: string }[] = [];
    const classTeacher = new Map<string, string>();
    for (const { section, p } of prt) classTeacher.set(section.id, p.id);
    const senior = sections.filter((s) => s.schoolClass.sortOrder >= 90);
    let next = 0;
    for (const [n, sec] of senior.entries()) {
        const stream = sec.stream?.name;
        const lead = stream ? subjectTeacher(pgt, STREAM_LEAD[stream] ?? 'ENG', 0) : tgt[next++ % tgt.length];
        if (lead) classTeacher.set(sec.id, lead.id);
        const own = classSubjects.filter((c) => c.classId === sec.classId && (c.streamId === null || c.streamId === sec.streamId));
        for (const c of own) {
            const code = codeOf.get(c.subjectId) ?? '';
            const t = ['ART', 'WE'].includes(code) ? art : ['HPE', 'PED'].includes(code) ? pe : subjectTeacher(stream || sec.schoolClass.sortOrder >= 140 ? pgt : tgt, code, n) ?? subjectTeacher(pgt, code, n);
            if (t) assignments.push({ tenantId, academicYearId: yearId, sectionId: sec.id, subjectId: c.subjectId, staffId: t.id });
        }
    }
    for (const { section, p } of prt) {
        for (const c of classSubjects.filter((x) => x.classId === section.classId && (x.streamId === null || x.streamId === section.streamId))) {
            assignments.push({ tenantId, academicYearId: yearId, sectionId: section.id, subjectId: c.subjectId, staffId: p.id });
        }
    }
    await db.teachingAssignment.createMany({ data: assignments, skipDuplicates: true });
    for (const [sectionId, staffId] of classTeacher) await db.section.update({ where: { id: sectionId }, data: { classTeacherId: staffId } });

    const firstTeacher = people.find((p) => p.designation === 'PRT' && p.login);
    return {
        staff: people.length,
        logins: users.length,
        assignments: assignments.length,
        sampleTeacher: firstTeacher ? users.find((u) => u.id === userIds[people.indexOf(firstTeacher)])?.username ?? null : null,
    };
};
