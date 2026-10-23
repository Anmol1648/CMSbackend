import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { currentYear } from '../academic/years.service';

/**
 * Demo AI learning for VII-B: a few tutor conversations and practice quizzes (written as data, so
 * the demo works without an AI key), so progress screens aren't empty. Marked is_demo.
 */

let seed = 3_177;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const DAY = 86_400_000;

const CHAT = {
    q: 'Why do leaves look green?',
    a: 'Great question! 🌿 Leaves have a green pigment called **chlorophyll**.\n\n- Chlorophyll absorbs red and blue light from sunlight.\n- It reflects green light, so our eyes see the leaf as green.\n- Chlorophyll is what helps the leaf make food by **photosynthesis**.\n\nCan you tell me which three things a leaf needs, along with chlorophyll, to make food?',
    q2: 'Sunlight, water and carbon dioxide?',
    a2: 'Exactly right! ✅ Sunlight, water and carbon dioxide — with chlorophyll — give glucose (food) and oxygen. Well done!',
};

export const createDemoLearn = async () => {
    const tenantId = getTenantId()!;
    const year = await currentYear();
    if (!year || (await db.learnChat.count({ where: { isDemo: true } }))) return { chats: 0, quizzes: 0 };
    const section = await db.section.findFirst({ where: { academicYearId: year.id, name: 'B', schoolClass: { name: 'Class VII' } }, select: { id: true, classId: true } });
    if (!section) return { chats: 0, quizzes: 0 };
    const subjects = await db.subject.findMany({ where: { name: { in: ['Science', 'Mathematics'] } }, select: { id: true, name: true } });
    const chapters = await db.chapter.findMany({ where: { classId: section.classId, subjectId: { in: subjects.map((s) => s.id) } }, select: { id: true, subjectId: true, name: true } });
    const students = await db.enrolment.findMany({ where: { academicYearId: year.id, sectionId: section.id, student: { status: 'active', userId: { not: null } } }, select: { student: { select: { id: true, userId: true } } } });
    const science = subjects.find((s) => s.name === 'Science');
    const nutrition = chapters.find((c) => c.name === 'Nutrition in Plants');
    let chats = 0;
    let quizzes = 0;
    for (const { student } of students) {
        if (!student.userId) continue;
        if (science && nutrition && rand() < 0.6) {
            const at = new Date(Date.now() - Math.floor(rand() * 10) * DAY);
            const c = await db.learnChat.create({ data: { tenantId, studentId: student.id, userId: student.userId, classId: section.classId, subjectId: science.id, chapterId: nutrition.id, mode: 'ask', title: CHAT.q, messages: 4, isDemo: true, createdAt: at, updatedAt: at } });
            await db.learnMessage.createMany({
                data: [
                    { tenantId, chatId: c.id, role: 'user', text: CHAT.q, createdAt: at },
                    { tenantId, chatId: c.id, role: 'assistant', text: CHAT.a, createdAt: new Date(at.getTime() + 5000) },
                    { tenantId, chatId: c.id, role: 'user', text: CHAT.q2, createdAt: new Date(at.getTime() + 60_000) },
                    { tenantId, chatId: c.id, role: 'assistant', text: CHAT.a2, createdAt: new Date(at.getTime() + 65_000) },
                ],
            });
            chats++;
        }
        for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) {
            const ch = chapters[Math.floor(rand() * chapters.length)];
            if (!ch) break;
            const total = 5;
            const at = new Date(Date.now() - Math.floor(rand() * 20) * DAY);
            await db.practiceQuiz.create({ data: { tenantId, studentId: student.id, userId: student.userId, classId: section.classId, subjectId: ch.subjectId, chapterId: ch.id, source: 'bank', questions: [], answers: [], score: Math.round(rand() * total), total, submittedAt: at, createdAt: at, isDemo: true } });
            quizzes++;
        }
    }
    return { chats, quizzes };
};

export const clearDemoLearn = async () => {
    await db.learnChat.deleteMany({ where: { isDemo: true } });
    await db.practiceQuiz.deleteMany({ where: { isDemo: true } });
};
