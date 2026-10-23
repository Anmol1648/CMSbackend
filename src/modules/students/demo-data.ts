import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { getSettings } from '../../core/settings';
import { hashPassword } from '../../core/password';
import { recordAudit } from '../../core/audit';
import { formatNumber, takeNumbers } from '../../core/numbering';
import { currentYear } from '../academic/years.service';
import { STUDENTS } from './students.settings';
import { counterKey, fullName } from './students.service';
import { ROLL_ORDERS } from './enrolment.service';
import { createDemoStaff } from '../staff/demo-staff';
import { createDemoEnquiries } from '../admissions/demo-enquiries';
import { clearDemoFees, createDemoFees, createDemoParentLogins } from '../fees/demo-fees';
import { clearDemoTimetable, createDemoTimetable } from '../timetable/demo-timetable';
import { clearDemoAttendance, createDemoAttendance } from '../attendance/demo-attendance';
import { clearDemoLeave, createDemoLeave } from '../leave/demo-leave';
import { clearDemoNotices, createDemoNotices } from '../notices/demo-notices';
import { clearDemoExams, createDemoExams } from '../exams/demo-exams';
import { clearDemoAlerts, createDemoAlerts } from '../alerts/demo-alerts';
import { clearDemoHomework, createDemoHomework } from '../homework/demo-homework';
import { clearDemoQuestions, createDemoQuestions } from '../questions/demo-questions';
import { randomUUID } from 'crypto';

/**
 * Demo data for showing the system: class teachers, families and students (Chamoli district, KV
 * pattern) placed in every section of the current year, with roll numbers, houses and optional
 * subjects. Everything is marked is_demo and `npm run demo:clear` removes it. Written in bulk.
 * The same password is used for every demo login so a demo can sign in as anyone.
 */

export const DEMO_PASSWORD = 'Demo@2026';

// A fixed seed: the same school gets the same demo data every time.
let seed = 20261016;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
/** Picks by weight: [[value, weight], …]. */
const weighted = <T>(list: readonly [T, number][]) => {
    let r = rand() * list.reduce((n, [, w]) => n + w, 0);
    for (const [v, w] of list) if ((r -= w) <= 0) return v;
    return list[list.length - 1][0];
};
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const BOYS = ['Aarav', 'Aditya', 'Akshay', 'Ankit', 'Anuj', 'Arjun', 'Aryan', 'Ayush', 'Deepak', 'Devansh', 'Dhruv', 'Gaurav', 'Harsh', 'Himanshu', 'Ishaan', 'Kartik', 'Kunal', 'Lakshya', 'Manish', 'Mayank', 'Mohit', 'Nikhil', 'Pankaj', 'Pranav', 'Rahul', 'Rajat', 'Rohan', 'Sachin', 'Sahil', 'Sanjay', 'Shivam', 'Shubham', 'Sumit', 'Tanmay', 'Tushar', 'Varun', 'Vikas', 'Vivek', 'Yash', 'Yuvraj'];
const GIRLS = ['Aditi', 'Akanksha', 'Ananya', 'Anjali', 'Anushka', 'Bhawna', 'Deepika', 'Divya', 'Garima', 'Isha', 'Jyoti', 'Kajal', 'Kavya', 'Khushi', 'Kritika', 'Manisha', 'Megha', 'Muskan', 'Neha', 'Nikita', 'Pallavi', 'Pooja', 'Priya', 'Radhika', 'Riya', 'Sakshi', 'Sanjana', 'Shivani', 'Shreya', 'Simran', 'Sneha', 'Sonam', 'Swati', 'Tanvi', 'Tanya', 'Vaishnavi', 'Vanshika', 'Yamini'];
const SURNAMES = ['Negi', 'Rawat', 'Bisht', 'Panwar', 'Bhandari', 'Joshi', 'Semwal', 'Thapliyal', 'Nautiyal', 'Chauhan', 'Rana', 'Butola', 'Kandari', 'Dimri', 'Sati', 'Bhatt', 'Gairola', 'Raturi', 'Uniyal', 'Pant', 'Kandpal', 'Rautela', 'Martolia', 'Farswan', 'Chamoli', 'Pundir', 'Kaintura', 'Mamgain', 'Sharma', 'Verma', 'Singh', 'Gupta'];
const FATHERS = ['Ramesh', 'Suresh', 'Mahesh', 'Dinesh', 'Rajendra', 'Vinod', 'Pramod', 'Harish', 'Girish', 'Kailash', 'Mohan', 'Govind', 'Prakash', 'Narendra', 'Manoj', 'Sunil', 'Anil', 'Rakesh', 'Deepak', 'Jagdish', 'Bhupendra', 'Virendra', 'Kuldeep', 'Sandeep', 'Pradeep'];
const MOTHERS = ['Sunita', 'Anita', 'Geeta', 'Kamla', 'Meena', 'Rekha', 'Savita', 'Usha', 'Poonam', 'Kiran', 'Sarita', 'Lata', 'Asha', 'Pushpa', 'Neelam', 'Manju', 'Seema', 'Renu', 'Bina', 'Rajni'];
/** Towns of Chamoli with their PIN codes and localities. */
const TOWNS: [string, string, string[]][] = [
    ['Joshimath (Jyotirmath)', '246443', ['Marwari', 'Sunil', 'Singhdhar', 'Ravigram', 'Gandhinagar', 'Upper Bazaar', 'Manoharbagh']],
    ['Gopeshwar', '246401', ['Kund', 'Gopinath Mandir Road', 'Police Line', 'Hall Bazaar']],
    ['Chamoli', '246424', ['Main Market', 'Bagar', 'Kothiyalsain']],
    ['Karnaprayag', '246444', ['Sangam Road', 'Subhashnagar', 'Mayapur']],
    ['Gauchar', '246429', ['Mela Ground', 'Bhatnagar']],
    ['Badrinath', '246422', ['Mana Road', 'Bamni Village']],
];
const OCCUPATIONS: [string, number][] = [['Defence / paramilitary', 25], ['Central government service', 25], ['State government service', 12], ['Private service', 10], ['Business', 10], ['Self-employed', 6], ['Farmer', 6], ['Teacher', 4], ['Doctor', 1], ['Engineer', 1]];
const MOTHER_JOBS: [string, number][] = [['Homemaker', 70], ['Teacher', 10], ['State government service', 6], ['Central government service', 4], ['Self-employed', 6], ['Private service', 4]];

type Ids = Map<string, string>;

const idsOf = async (master: string): Promise<Ids> => new Map((await db.masterValue.findMany({ where: { master }, select: { id: true, name: true } })).map((m) => [m.name, m.id]));

export const hasDemoData = async () => (await db.student.count({ where: { isDemo: true } })) > 0;

export const createDemoData = async (options: { perSection?: [number, number] } = {}) => {
    const tenantId = getTenantId()!;
    if (await hasDemoData()) throw new Error('This school already has demo data. Run `npm run demo:clear` first.');
    const year = await currentYear();
    if (!year) throw new Error('Set up an academic year first (Configuration → Academic Years).');
    const sections = await db.section.findMany({
        where: { academicYearId: year.id, isActive: true },
        include: { schoolClass: true, stream: { select: { name: true } } },
        orderBy: [{ schoolClass: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
    if (!sections.length) throw new Error('The current year has no sections (Configuration → Classes & Sections).');

    const lists: Record<string, Ids> = {};
    for (const m of ['gender', 'blood_group', 'religion', 'caste_category', 'mother_tongue', 'nationality', 'disability', 'student_category', 'admission_type', 'relation', 'occupation', 'qualification', 'income_range', 'house', 'previous_board', 'state', 'leaving_reason']) {
        lists[m] = await idsOf(m);
    }
    const uk = lists.state.get('Uttarakhand') ?? null;
    const chamoli = uk ? (await db.masterValue.findFirst({ where: { master: 'district', parentId: uk, name: 'Chamoli' } }))?.id ?? null : null;
    const towns = chamoli ? new Map((await db.masterValue.findMany({ where: { master: 'city', parentId: chamoli } })).map((t) => [t.name, t.id])) : new Map<string, string>();
    const value = (list: string, name: string) => lists[list].get(name) ?? null;
    const houses = [...lists.house.values()];
    const s = await getSettings({ pattern: STUDENTS.admissionPattern, reset: STUDENTS.admissionReset, start: STUDENTS.admissionStart, login: STUDENTS.studentLogin, byNumber: STUDENTS.studentUsername });
    const passwordHash = await hashPassword(DEMO_PASSWORD);

    // ─── Staff: office, teachers (class and subject teachers of every section), support ────
    const roles = await db.role.findMany({ where: { slug: { in: ['student'] } }, select: { id: true, slug: true } });
    const roleId = (slug: string) => roles.find((r) => r.slug === slug)?.id;
    const taken = new Set((await db.user.findMany({ select: { username: true } })).map((u) => u.username));
    const uniqueName = (base: string) => {
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
        taken.add(name);
        return name;
    };
    const staff = await createDemoStaff(year.id, year.startDate.getUTCFullYear(), sections, passwordHash, { pick, between }, uniqueName);

    // ─── Students and families ───────────────────────────────────────────────
    const optional = await db.classSubject.findMany({ where: { academicYearId: year.id, isOptional: true }, select: { classId: true, streamId: true, subjectId: true } });
    const yearStart = year.startDate.getUTCFullYear();
    const [lo, hi] = options.perSection ?? [9, 15];

    interface Planned {
        familyKey: number;
        sectionId: string;
        classId: string;
        className: string;
        student: Omit<Prisma.StudentCreateManyInput, 'tenantId' | 'admissionNo'>;
        houseId: string | null;
        optionalSubjectIds: string[];
    }
    const planned: Planned[] = [];
    const families: { key: number; surname: string; town: [string, string, string[]]; locality: string }[] = [];

    for (const sec of sections) {
        const classIndex = sec.schoolClass.sortOrder / 10 - 1; // 0 = Bal Vatika 1 in the starter set-up
        const age = 3 + Math.max(0, Math.min(classIndex, 14));
        const count = between(lo, hi);
        for (let i = 0; i < count; i++) {
            const girl = rand() < 0.48;
            // About one in six students has a brother or sister in another class.
            const sibling = families.length > 20 && rand() < 0.16 ? pick(families) : null;
            const family = sibling ?? { key: families.length, surname: pick(SURNAMES), town: weighted(TOWNS.map((t, k) => [t, k === 0 ? 50 : 10] as [(typeof TOWNS)[number], number])), locality: '' };
            if (!sibling) {
                family.locality = pick(family.town[2]);
                families.push(family);
            }
            const yearsHere = Math.min(classIndex, between(0, 6));
            const transfer = yearsHere > 0 && rand() < 0.2;
            const dob = new Date(Date.UTC(yearStart - age - 1 + between(0, 1), between(0, 11), between(1, 28)));
            const religion = weighted([['Hindu', 88], ['Muslim', 5], ['Sikh', 3], ['Christian', 2], ['Buddhist', 2]] as [string, number][]);
            const opts = optional.filter((o) => o.classId === sec.classId && (o.streamId === null || o.streamId === sec.streamId)).map((o) => o.subjectId);
            planned.push({
                familyKey: family.key,
                sectionId: sec.id,
                classId: sec.classId,
                className: sec.schoolClass.shortName ?? sec.schoolClass.name,
                houseId: houses.length ? pick(houses) : null,
                // One or two of the optional subjects (Hindi or Sanskrit, an elective…).
                optionalSubjectIds: opts.length ? [...new Set([pick(opts), ...(rand() < 0.4 ? [pick(opts)] : [])])] : [],
                student: {
                    firstName: girl ? pick(GIRLS) : pick(BOYS),
                    lastName: family.surname,
                    dateOfBirth: dob,
                    admissionDate: new Date(Date.UTC(yearStart - yearsHere, 3, between(1, 20))),
                    admissionTypeId: value('admission_type', transfer ? 'Transfer (from another school)' : 'New admission'),
                    genderId: value('gender', girl ? 'Female' : 'Male'),
                    bloodGroupId: value('blood_group', weighted([['B+', 32], ['O+', 30], ['A+', 22], ['AB+', 8], ['O-', 3], ['B-', 2], ['A-', 2], ['AB-', 1]] as [string, number][])),
                    religionId: value('religion', religion),
                    casteCategoryId: value('caste_category', weighted([['General', 48], ['OBC', 22], ['SC', 20], ['ST', 6], ['EWS', 4]] as [string, number][])),
                    motherTongueId: value('mother_tongue', weighted([['Garhwali', 48], ['Hindi', 38], ['Kumaoni', 7], ['Nepali', 4], ['Punjabi', 3]] as [string, number][])),
                    nationalityId: value('nationality', rand() < 0.02 ? 'Nepalese' : 'Indian'),
                    disabilityId: rand() < 0.02 ? value('disability', pick(['Low vision', 'Specific learning disabilities', 'Locomotor disability', 'Hearing impairment'])) : null,
                    categoryId: [...lists.student_category.entries()].find(([n]) => n.startsWith(`Category ${weighted([['I', 45], ['II', 15], ['III', 15], ['IV', 5], ['V', 18], ['VI', 2]] as [string, number][])} `))?.[1] ?? null,
                    addressLine: `${between(1, 240)}, ${family.locality}`,
                    stateId: uk,
                    districtId: chamoli,
                    cityId: towns.get(family.town[0]) ?? null,
                    pinCode: family.town[1],
                    previousSchool: transfer ? pick(['Kendriya Vidyalaya Gopeshwar', 'Kendriya Vidyalaya Dehradun', 'Saraswati Vidya Mandir, Joshimath', 'GIC Joshimath', "St. Mary's School, Srinagar"]) : null,
                    previousBoardId: transfer ? value('previous_board', pick(['CBSE', 'Uttarakhand Board (UBSE)'])) : null,
                    medicalNotes: rand() < 0.04 ? pick(['Asthma: carries an inhaler', 'Allergic to peanuts', 'Wears spectacles']) : null,
                    emergencyName: null,
                    isDemo: true,
                },
            });
        }
    }

    // Families and their parents (fathers are the main contact; most mothers have a mobile too).
    const familyRows = await db.family.createManyAndReturn({ data: families.map(() => ({ tenantId, isDemo: true })), select: { id: true } });
    const familyId = (key: number) => familyRows[key].id;
    const mobile = () => `9${between(100000000, 999999999)}`;
    const guardianRows: Prisma.GuardianCreateManyInput[] = [];
    for (const f of families) {
        const fatherMobile = mobile();
        guardianRows.push({
            tenantId, familyId: familyId(f.key), relationId: value('relation', 'Father'), name: `${pick(FATHERS)} ${f.surname}`, mobile: fatherMobile, isPrimary: true, sortOrder: 10,
            occupationId: value('occupation', weighted(OCCUPATIONS)), qualificationId: value('qualification', weighted([['Graduate', 40], ['Post graduate', 20], ['Intermediate (12th)', 25], ['High school (10th)', 10], ['Diploma', 5]] as [string, number][])),
            incomeRangeId: value('income_range', weighted([['₹2.5–5 lakh', 35], ['₹5–10 lakh', 30], ['₹1–2.5 lakh', 20], ['Above ₹10 lakh', 10], ['Below ₹1 lakh', 5]] as [string, number][])),
        });
        guardianRows.push({
            tenantId, familyId: familyId(f.key), relationId: value('relation', 'Mother'), name: `${pick(MOTHERS)} ${f.surname}`, mobile: rand() < 0.7 ? mobile() : null, isPrimary: false, sortOrder: 20,
            occupationId: value('occupation', weighted(MOTHER_JOBS)), qualificationId: value('qualification', weighted([['Graduate', 40], ['Intermediate (12th)', 30], ['Post graduate', 15], ['High school (10th)', 15]] as [string, number][])),
        });
    }
    await db.guardian.createMany({ data: guardianRows });

    // Admission numbers by the school's pattern, taken in one go per counter.
    const parts = planned.map((p) => ({ date: p.student.admissionDate as Date, academicYear: year.name, classId: p.classId, className: p.className }));
    const keys = parts.map((p) => counterKey(s.reset, p));
    const firstOf = new Map<string, number>();
    for (const k of new Set(keys)) firstOf.set(k, await takeNumbers(k, s.start, keys.filter((x) => x === k).length));
    const nextOf = new Map(firstOf);
    const admissionNos = parts.map((p, i) => {
        const seq = nextOf.get(keys[i])!;
        nextOf.set(keys[i], seq + 1);
        return formatNumber(s.pattern, { ...p, seq });
    });

    // Student logins (System Settings → Students), all with the demo password; ids made here so
    // the students can point at them in the same insert.
    const login = s.login === 'auto';
    const userIds = planned.map(() => (login ? randomUUID() : null));
    if (login) {
        await db.user.createMany({
            data: planned.map((p, i) => ({
                id: userIds[i]!,
                tenantId,
                kind: 'student' as const,
                username: uniqueName(s.byNumber === 'admission_number' ? admissionNos[i].replace(/[^A-Za-z0-9]/g, '').toLowerCase() : `${p.student.firstName}.${p.student.lastName}`.toLowerCase()),
                displayName: fullName({ firstName: p.student.firstName, lastName: p.student.lastName ?? null }),
                passwordHash,
                mustChangePassword: false,
                isDemo: true,
            })),
        });
        const studentRole = roleId('student');
        if (studentRole) await db.userRole.createMany({ data: userIds.map((u) => ({ tenantId, userId: u!, roleId: studentRole })) });
    }
    const students = await db.student.createManyAndReturn({
        data: planned.map((p, i) => ({ tenantId, ...p.student, admissionNo: admissionNos[i], familyId: familyId(p.familyKey), userId: userIds[i] })),
        select: { id: true, admissionNo: true, firstName: true, lastName: true, userId: true },
    });

    // Roll numbers in the school's order (System Settings → Students), section by section.
    const { order } = await getSettings({ order: STUDENTS.rollOrder });
    const girlId = value('gender', 'Female');
    const roll = new Map<number, number>();
    if (order !== 'manual') {
        for (const sec of sections) {
            const here = planned.map((p, i) => ({ p, i })).filter((x) => x.p.sectionId === sec.id);
            here.sort((a, b) =>
                ROLL_ORDERS[order](
                    { firstName: a.p.student.firstName, lastName: a.p.student.lastName ?? null, admissionNo: admissionNos[a.i], admissionDate: a.p.student.admissionDate as Date, girl: !!girlId && a.p.student.genderId === girlId },
                    { firstName: b.p.student.firstName, lastName: b.p.student.lastName ?? null, admissionNo: admissionNos[b.i], admissionDate: b.p.student.admissionDate as Date, girl: !!girlId && b.p.student.genderId === girlId }
                )
            );
            here.forEach((x, n) => roll.set(x.i, n + 1));
        }
    }
    await db.enrolment.createMany({
        data: planned.map((p, i) => ({ tenantId, studentId: students[i].id, academicYearId: year.id, sectionId: p.sectionId, rollNumber: roll.get(i) ?? null, houseId: p.houseId, optionalSubjectIds: p.optionalSubjectIds })),
    });
    const logins = login ? students.length : 0;

    // A few students who left during the year.
    const reason = value('leaving_reason', "Parent's transfer");
    for (const st of students.slice(5, 8)) {
        const left = await db.student.update({ where: { id: st.id }, data: { status: 'left', statusDate: new Date(Date.UTC(yearStart, 8, 15)), leavingReasonId: reason } });
        if (left.userId) await db.user.update({ where: { id: left.userId }, data: { status: 'disabled' } });
    }

    // ─── Admission enquiries (the newly admitted students came through one) ────
    const sessionStart = year.startDate.getTime();
    const newcomers = planned
        .map((p, i) => ({ p, st: students[i] }))
        .filter(({ p }) => (p.student.admissionDate as Date).getTime() >= sessionStart - 90 * 86_400_000)
        .map(({ p, st }) => ({ id: st.id, classId: p.classId, firstName: st.firstName, lastName: st.lastName, dateOfBirth: (p.student.dateOfBirth as Date | null) ?? null, genderId: (p.student.genderId as string | null) ?? null }));
    const enquiries = await createDemoEnquiries(year, newcomers, { pick, between, chance: (p) => rand() < p });

    // ─── Parent logins and fees ──────────────────────────────────────────────
    const parentLogins = await createDemoParentLogins(passwordHash);
    const fees = { ...(await createDemoFees(year, { pick, between, chance: (p) => rand() < p })), parentLogins };
    const timetable = await createDemoTimetable(year.id);
    const attendance = await createDemoAttendance(year);
    const leave = await createDemoLeave();
    const notices = await createDemoNotices();
    const exams = await createDemoExams();
    const alerts = await createDemoAlerts();
    const homework = await createDemoHomework();
    const questions = await createDemoQuestions();

    await recordAudit({ action: 'demo_data', entity: 'school', changes: { students: students.length, families: families.length, staff: staff.staff, enquiries: enquiries.enquiries, receipts: fees.receipts } });
    return { year: year.name, sections: sections.length, students: students.length, families: families.length, staff, enquiries, fees, timetable, attendance, leave, notices, exams, alerts, homework, questions, studentLogins: logins, sampleStudent: students[0]?.admissionNo };
};

/** Removes everything the demo data created (students, families, demo logins); nothing else. */
export const clearDemoData = async () => {
    const demoUsers = (await db.user.findMany({ where: { isDemo: true }, select: { id: true } })).map((u) => u.id);
    const demoStaff = (await db.staff.findMany({ where: { isDemo: true }, select: { id: true } })).map((x) => x.id);
    await db.section.updateMany({ where: { classTeacherId: { in: demoStaff } }, data: { classTeacherId: null } });
    // Reporting lines first (staff point at each other), then the records (assignments go with them).
    // Fee receipts and online payments of demo students go first (they keep students).
    const receipts = await clearDemoFees();
    // Timetables point at demo staff.
    await clearDemoTimetable();
    await clearDemoAlerts();
    await clearDemoHomework();
    await clearDemoQuestions();
    await clearDemoExams();
    await clearDemoNotices();
    await clearDemoLeave();
    await clearDemoAttendance();
    // Enquiries point at demo students and staff.
    const enquiries = await db.enquiry.deleteMany({ where: { isDemo: true } });
    // Real enquiries keep their record, without the demo person.
    await db.enquiry.updateMany({ where: { assignedTo: { isDemo: true } }, data: { assignedToId: null } });
    await db.enquiry.updateMany({ where: { student: { isDemo: true } }, data: { studentId: null } });
    if (!(await db.enquiry.count())) await db.numberSequence.deleteMany({ where: { OR: [{ key: { startsWith: 'enquiry' } }, { key: { startsWith: 'registration' } }] } });
    await db.staff.updateMany({ where: { isDemo: true }, data: { reportsToId: null } });
    const staffRemoved = await db.staff.deleteMany({ where: { isDemo: true } });
    const students = await db.student.deleteMany({ where: { isDemo: true } });
    const families = await db.family.deleteMany({ where: { isDemo: true, students: { none: {} } } });
    const users = await db.user.deleteMany({ where: { id: { in: demoUsers } } });
    // With no real students (staff) yet, admission numbers (employee codes) start again from the first one.
    let counterReset = false;
    if (!(await db.student.count())) {
        await db.numberSequence.deleteMany({ where: { key: { startsWith: 'admission' } } });
        counterReset = true;
    }
    if (!(await db.staff.count())) await db.numberSequence.deleteMany({ where: { key: 'staff' } });
    await recordAudit({ action: 'demo_cleared', entity: 'school', changes: { students: students.count, families: families.count, staff: staffRemoved.count, enquiries: enquiries.count, receipts, logins: users.count } });
    return { students: students.count, families: families.count, staff: staffRemoved.count, enquiries: enquiries.count, receipts, logins: users.count, counterReset };
};
