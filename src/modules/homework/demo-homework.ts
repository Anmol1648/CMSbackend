import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';
import { listOptions } from '../masters/masters.service';
import { dayDate, todayIST } from '../attendance/attendance.settings';
import { schoolDays } from '../attendance/calendar.service';
import { takers } from '../exams/marks.service';

/**
 * Demo homework: the last two school weeks of homework in every section from its subject teachers,
 * handed in (some late, some missing), most of it checked with grades and remarks; homework due
 * tomorrow and a draft too. Students and parents are not alerted. Marked is_demo.
 */

let seed = 5_903;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(new Date(dayDate(day).getTime() + n * DAY));

const TASKS: Record<string, string[]> = {
    Mathematics: ['Exercise 4.2: questions 1 to 10', 'Solve the worksheet on fractions', 'Practice the tables of 12 to 15', 'Exercise 6.1: all questions', 'Make a chart of shapes and their formulas'],
    Science: ['Draw and label the parts of a plant cell', 'Answer the questions at the end of chapter 5', 'Write five uses of magnets', 'Learn the definitions in the notebook'],
    English: ['Write a paragraph on “My favourite festival”', 'Learn the spellings of lesson 7', 'Read chapter 3 and write its summary', 'Write a letter to your friend about your holidays'],
    Hindi: ['पाठ 4 के प्रश्न-उत्तर लिखिए', '“दीपावली” पर निबंध लिखिए', 'पाठ 6 के कठिन शब्द याद कीजिए', 'अपने मित्र को पत्र लिखिए'],
    'Social Science': ['Mark the states and capitals on the map of India', 'Answer the questions of chapter 3 (History)', 'Make a timeline of the Mughal emperors', 'Learn the important dates of chapter 2'],
    Sanskrit: ['शब्द रूप “बालक” याद कीजिए', 'पाठ 3 का अनुवाद लिखिए', 'धातु रूप “पठ्” लिखिए'],
};
const GENERAL = ['Complete the notebook work of this week', 'Revise the chapter done in class', 'Bring the project material on Monday'];
const REMARKS = ['Neat work', 'Well done', 'Good, keep it up', 'Write more carefully', 'Complete the corrections', 'Very good effort', null, null];
const ANSWERS = ['Done in the notebook; photo attached.', 'Answers written below.', 'Completed.', 'Please see my notebook.'];

export const createDemoHomework = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year) return { homework: 0, submissions: 0 };
    if (await db.homework.count({ where: { isDemo: true } })) return { homework: 0, submissions: 0 };
    const [types, grades] = await Promise.all([listOptions('homework_type'), listOptions('homework_grade')]);
    if (!(await db.masterValue.findFirst({ where: { master: 'notification_type', code: 'homework' } })))
        await db.masterValue.create({ data: { tenantId, master: 'notification_type', name: 'Homework', code: 'homework', sortOrder: 99, extra: { icon: 'menu_book' } } });
    const typeId = (n: string) => types.find((t) => t.name === n)?.id ?? null;
    const goodGrades = grades.filter((g) => !((g.extra ?? {}) as Record<string, unknown>).redo);
    const redo = grades.find((g) => ((g.extra ?? {}) as Record<string, unknown>).redo);

    const today = todayIST();
    const days = (await schoolDays(addDays(today, -20), today, 'students')).slice(-10);
    const assignments = await db.teachingAssignment.findMany({
        where: { academicYearId: year.id, section: { isActive: true } },
        select: { sectionId: true, subjectId: true, staffId: true, subject: { select: { name: true } }, staff: { select: { userId: true } } },
    });
    const bySection = new Map<string, typeof assignments>();
    for (const a of assignments) bySection.set(a.sectionId, [...(bySection.get(a.sectionId) ?? []), a]);
    const roster = new Map<string, string[]>();
    const studentsOf = async (sectionId: string, subjectId: string) => {
        const k = `${sectionId}|${subjectId}`;
        if (!roster.has(k)) roster.set(k, (await takers(year.id, sectionId, subjectId)).map((t) => t.student.id));
        return roster.get(k)!;
    };

    let homework = 0;
    const subs: Prisma.HomeworkSubmissionCreateManyInput[] = [];
    const nextDay = (day: string, n: number) => days.find((d) => d > day && days.indexOf(d) - days.indexOf(day) >= n) ?? addDays(day, n + (new Date(`${day}T00:00:00Z`).getUTCDay() === 5 ? 2 : 0));
    for (const [sectionId, list] of bySection) {
        for (const day of days) {
            const count = rand() < 0.35 ? 2 : 1;
            for (let i = 0; i < count; i++) {
                const a = pick(list);
                const online = rand() < 0.7;
                const due = nextDay(day, rand() < 0.75 ? 1 : 2);
                const h = await db.homework.create({
                    data: {
                        tenantId,
                        academicYearId: year.id,
                        sectionId,
                        subjectId: a.subjectId,
                        typeId: typeId(rand() < 0.85 ? 'Homework' : 'Assignment'),
                        title: pick(TASKS[a.subject.name] ?? GENERAL),
                        details: online ? 'Do it in your notebook and upload a clear photo, or type your answer.' : 'Do it in your notebook. It will be checked in class.',
                        givenOn: dayDate(day),
                        dueOn: dayDate(due),
                        mode: online ? 'online' : 'class',
                        status: 'published',
                        publishAt: new Date(`${day}T09:30:00+05:30`),
                        alertedAt: new Date(`${day}T09:30:00+05:30`),
                        staffId: a.staffId,
                        createdBy: a.staff.userId,
                        isDemo: true,
                    },
                    select: { id: true },
                });
                homework++;
                if (due > today) continue;
                for (const studentId of await studentsOf(sectionId, a.subjectId)) {
                    const r = rand();
                    const at = new Date(`${due}T${r < 0.5 ? '07' : '18'}:${String(Math.floor(rand() * 59)).padStart(2, '0')}:00+05:30`);
                    if (!online) {
                        subs.push({ tenantId, homeworkId: h.id, studentId, status: r < 0.87 ? 'done' : 'not_done', checkedAt: at, checkedBy: a.staff.userId, isDemo: true });
                        continue;
                    }
                    if (r < 0.12) continue; // not handed in
                    const late = r > 0.92;
                    const checked = rand() < 0.75;
                    const sendBack = checked && rand() < 0.06 && redo;
                    subs.push({
                        tenantId,
                        homeworkId: h.id,
                        studentId,
                        status: !checked ? (late ? 'late' : 'submitted') : sendBack ? 'redo' : 'checked',
                        answer: pick(ANSWERS),
                        submittedAt: late ? new Date(at.getTime() + DAY) : at,
                        checkedAt: checked ? new Date(at.getTime() + DAY) : null,
                        checkedBy: checked ? a.staff.userId : null,
                        gradeId: checked ? (sendBack ? redo!.id : pick(goodGrades)?.id ?? null) : null,
                        remark: checked ? (sendBack ? 'Do it again neatly' : pick(REMARKS)) : null,
                        isDemo: true,
                    });
                }
            }
        }
        // Something due tomorrow, and a draft, in every section.
        const a = pick(list);
        const tomorrow = nextDay(today, 1);
        await db.homework.create({ data: { tenantId, academicYearId: year.id, sectionId, subjectId: a.subjectId, typeId: typeId('Homework'), title: pick(TASKS[a.subject.name] ?? GENERAL), details: 'Upload a photo of your notebook.', givenOn: dayDate(today), dueOn: dayDate(tomorrow), mode: 'online', status: 'published', publishAt: new Date(), alertedAt: new Date(), staffId: a.staffId, createdBy: a.staff.userId, isDemo: true } });
        await db.homework.create({ data: { tenantId, academicYearId: year.id, sectionId, subjectId: a.subjectId, typeId: typeId('Project'), title: 'Project: make a model (details to follow)', details: 'Groups of four. Material list will be given in class.', givenOn: dayDate(today), dueOn: dayDate(addDays(today, 14)), mode: 'class', status: 'draft', staffId: a.staffId, createdBy: a.staff.userId, isDemo: true } });
        homework += 2;
    }
    for (let i = 0; i < subs.length; i += 2000) await db.homeworkSubmission.createMany({ data: subs.slice(i, i + 2000), skipDuplicates: true });
    return { homework, submissions: subs.length };
};

export const clearDemoHomework = async () => {
    await db.homework.deleteMany({ where: { isDemo: true } });
};
