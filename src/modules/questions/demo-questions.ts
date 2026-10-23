import { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { listOptions } from '../masters/masters.service';

/**
 * Demo syllabus and question bank: NCERT chapters of Classes VI–VIII Science and Mathematics (and a
 * few subjects of Class VII), and about 150 Class VII questions of every kind, most approved, some
 * waiting for review and some AI drafts. Marked is_demo.
 */

const CHAPTERS: Record<string, Record<string, [string, string[]][]>> = {
    'Class VII': {
        Science: [
            ['Nutrition in Plants', ['Modes of nutrition', 'Photosynthesis', 'Parasites and saprotrophs', 'Restoring soil nutrients']],
            ['Nutrition in Animals', ['Digestion in humans', 'Digestion in grass-eating animals', 'Feeding in amoeba']],
            ['Heat', ['Hot and cold', 'Measuring temperature', 'Conduction, convection, radiation', 'Clothes for summer and winter']],
            ['Acids, Bases and Salts', ['Acids and bases', 'Natural indicators', 'Neutralisation', 'Neutralisation in daily life']],
            ['Physical and Chemical Changes', ['Physical changes', 'Chemical changes', 'Rusting of iron', 'Crystallisation']],
            ['Respiration in Organisms', ['Why we respire', 'Breathing', 'Respiration in other animals and plants']],
            ['Transportation in Animals and Plants', ['Circulatory system', 'Excretion', 'Transport of water and minerals in plants']],
            ['Reproduction in Plants', ['Vegetative propagation', 'Sexual reproduction', 'Seed dispersal']],
            ['Motion and Time', ['Slow or fast', 'Speed', 'Measuring time', 'Distance–time graph']],
            ['Electric Current and its Effects', ['Symbols of components', 'Heating effect', 'Magnetic effect', 'Electromagnet']],
            ['Light', ['Light travels in a straight line', 'Reflection', 'Spherical mirrors', 'Lenses']],
            ['Forests: Our Lifeline', ['Life in a forest', 'Interdependence', 'Importance of forests']],
            ['Wastewater Story', ['Water, our lifeline', 'Sewage', 'Treatment of wastewater', 'Sanitation']],
        ],
        Mathematics: [
            ['Integers', ['Operations on integers', 'Properties of addition and subtraction', 'Multiplication and division of integers']],
            ['Fractions and Decimals', ['Multiplication of fractions', 'Division of fractions', 'Multiplication and division of decimals']],
            ['Data Handling', ['Mean, median, mode', 'Bar graphs', 'Chance and probability']],
            ['Simple Equations', ['Setting up an equation', 'Solving an equation', 'Applications']],
            ['Lines and Angles', ['Complementary and supplementary angles', 'Pairs of lines', 'Transversal']],
            ['The Triangle and its Properties', ['Medians and altitudes', 'Angle sum property', 'Pythagoras property']],
            ['Comparing Quantities', ['Ratio and proportion', 'Percentage', 'Profit and loss', 'Simple interest']],
            ['Rational Numbers', ['Positive and negative rational numbers', 'Operations on rational numbers']],
            ['Perimeter and Area', ['Squares and rectangles', 'Parallelogram and triangle', 'Circles']],
            ['Algebraic Expressions', ['Terms and coefficients', 'Like and unlike terms', 'Addition and subtraction']],
            ['Exponents and Powers', ['Exponents', 'Laws of exponents', 'Standard form']],
            ['Symmetry', ['Lines of symmetry', 'Rotational symmetry']],
            ['Visualising Solid Shapes', ['Faces, edges, vertices', 'Nets', 'Viewing different sections']],
        ],
        English: [
            ['Three Questions', ['Reading', 'Vocabulary', 'Grammar: question forms']],
            ['A Gift of Chappals', ['Reading', 'Vocabulary']],
            ['Gopal and the Hilsa Fish', ['Reading', 'Speech']],
            ['The Ashes That Made Trees Bloom', ['Reading', 'Writing']],
            ['Quality', ['Reading', 'Vocabulary']],
        ],
        'Social Science': [
            ['Tracing Changes Through a Thousand Years', ['Maps', 'New and old terminologies', 'Historians and their sources']],
            ['New Kings and Kingdoms', ['The emergence of new dynasties', 'The Cholas']],
            ['Environment', ['Natural and human environment', 'Ecosystem']],
            ['On Equality', ['Equal right to vote', 'Recognising dignity']],
        ],
        Hindi: [
            ['हम पंछी उन्मुक्त गगन के', ['कविता', 'भावार्थ']],
            ['दादी माँ', ['पाठ', 'शब्दार्थ']],
            ['हिमालय की बेटियाँ', ['निबंध', 'प्रश्न-उत्तर']],
            ['कठपुतली', ['कविता', 'भावार्थ']],
        ],
    },
    'Class VI': {
        Science: [['Food: Where Does It Come From?', []], ['Components of Food', []], ['Fibre to Fabric', []], ['Sorting Materials into Groups', []], ['Getting to Know Plants', []], ['Body Movements', []]],
        Mathematics: [['Knowing Our Numbers', []], ['Whole Numbers', []], ['Playing with Numbers', []], ['Basic Geometrical Ideas', []], ['Integers', []], ['Fractions', []]],
    },
    'Class VIII': {
        Science: [['Crop Production and Management', []], ['Microorganisms: Friend and Foe', []], ['Coal and Petroleum', []], ['Combustion and Flame', []], ['Force and Pressure', []], ['Friction', []]],
        Mathematics: [['Rational Numbers', []], ['Linear Equations in One Variable', []], ['Understanding Quadrilaterals', []], ['Data Handling', []], ['Squares and Square Roots', []], ['Cubes and Cube Roots', []]],
    },
};

type Q = { ch: string; type: string; text: string; options?: [string, boolean][]; answer?: string; explanation?: string; marks?: number; d?: 'Easy' | 'Medium' | 'Hard' };

const SCIENCE: Q[] = [
    { ch: 'Nutrition in Plants', type: 'mcq', text: 'Which gas do plants take in for photosynthesis?', options: [['Oxygen', false], ['Carbon dioxide', true], ['Nitrogen', false], ['Hydrogen', false]], explanation: 'Leaves take in carbon dioxide through the stomata.', d: 'Easy' },
    { ch: 'Nutrition in Plants', type: 'mcq', text: 'The green pigment in leaves is called', options: [['Chlorophyll', true], ['Haemoglobin', false], ['Melanin', false], ['Starch', false]], d: 'Easy' },
    { ch: 'Nutrition in Plants', type: 'fill', text: 'Plants that make their own food are called ____.', answer: 'autotrophs|autotrophic', d: 'Easy' },
    { ch: 'Nutrition in Plants', type: 'true_false', text: 'Cuscuta (amarbel) is a parasitic plant.', answer: 'true', d: 'Easy' },
    { ch: 'Nutrition in Plants', type: 'mcq', text: 'Which of these is an insectivorous plant?', options: [['Pitcher plant', true], ['Cuscuta', false], ['Mushroom', false], ['Rose', false]], d: 'Medium' },
    { ch: 'Nutrition in Plants', type: 'short', text: 'Why are leaves called the food factories of a plant?', answer: 'Leaves make food for the whole plant by photosynthesis, using carbon dioxide, water and sunlight with the help of chlorophyll.', marks: 2, d: 'Medium' },
    { ch: 'Nutrition in Plants', type: 'multi', text: 'Which of these are needed for photosynthesis?', options: [['Sunlight', true], ['Water', true], ['Carbon dioxide', true], ['Oxygen', false]], marks: 2, d: 'Medium' },
    { ch: 'Nutrition in Animals', type: 'mcq', text: 'Digestion of food is completed in the', options: [['Stomach', false], ['Small intestine', true], ['Large intestine', false], ['Mouth', false]], d: 'Medium' },
    { ch: 'Nutrition in Animals', type: 'fill', text: 'The largest gland in the human body is the ____.', answer: 'liver', d: 'Easy' },
    { ch: 'Nutrition in Animals', type: 'true_false', text: 'Amoeba takes in food with the help of false feet (pseudopodia).', answer: 'true', d: 'Easy' },
    { ch: 'Nutrition in Animals', type: 'short', text: 'Why do cows chew the cud?', answer: 'Cows swallow grass quickly and store it in the rumen; later the partly digested food (cud) comes back to the mouth and is chewed again so that cellulose can be digested.', marks: 2, d: 'Medium' },
    { ch: 'Heat', type: 'mcq', text: 'The normal temperature of the human body is', options: [['37 °C', true], ['42 °C', false], ['32 °C', false], ['98 °C', false]], d: 'Easy' },
    { ch: 'Heat', type: 'mcq', text: 'Heat from the Sun reaches the Earth by', options: [['Conduction', false], ['Convection', false], ['Radiation', true], ['All of these', false]], d: 'Medium' },
    { ch: 'Heat', type: 'true_false', text: 'Dark-coloured clothes absorb more heat than light-coloured clothes.', answer: 'true', d: 'Easy' },
    { ch: 'Heat', type: 'fill', text: 'Materials that let heat pass through them easily are called ____.', answer: 'conductors|good conductors', d: 'Easy' },
    { ch: 'Heat', type: 'short', text: 'Why do we wear woollen clothes in winter?', answer: 'Wool traps air between its fibres; air is a poor conductor of heat, so body heat does not escape.', marks: 2, d: 'Medium' },
    { ch: 'Acids, Bases and Salts', type: 'mcq', text: 'Turmeric turns red when it is put in', options: [['An acid', false], ['A base', true], ['Water', false], ['A salt solution', false]], d: 'Medium' },
    { ch: 'Acids, Bases and Salts', type: 'fill', text: 'The reaction between an acid and a base is called ____.', answer: 'neutralisation|neutralization', d: 'Easy' },
    { ch: 'Acids, Bases and Salts', type: 'true_false', text: 'Lemon juice is basic in nature.', answer: 'false', explanation: 'Lemon juice contains citric acid.', d: 'Easy' },
    { ch: 'Acids, Bases and Salts', type: 'short', text: 'Why is an antacid taken when we have acidity?', answer: 'An antacid such as milk of magnesia is a base; it neutralises the extra acid in the stomach.', marks: 2, d: 'Medium' },
    { ch: 'Physical and Chemical Changes', type: 'mcq', text: 'Which of these is a chemical change?', options: [['Melting of ice', false], ['Rusting of iron', true], ['Tearing paper', false], ['Dissolving sugar in water', false]], d: 'Easy' },
    { ch: 'Physical and Chemical Changes', type: 'true_false', text: 'Crystallisation is a physical change.', answer: 'true', d: 'Medium' },
    { ch: 'Physical and Chemical Changes', type: 'long', text: 'What is rusting? Write two ways to prevent it.', answer: 'Rusting is the formation of a brown layer (iron oxide) on iron when it is exposed to oxygen and moisture. It is a chemical change. It can be prevented by painting or greasing iron, and by galvanising (coating with zinc).', marks: 3, d: 'Medium' },
    { ch: 'Respiration in Organisms', type: 'mcq', text: 'In which organ does gas exchange take place in humans?', options: [['Heart', false], ['Lungs', true], ['Kidney', false], ['Liver', false]], d: 'Easy' },
    { ch: 'Respiration in Organisms', type: 'fill', text: 'Respiration without oxygen is called ____ respiration.', answer: 'anaerobic', d: 'Medium' },
    { ch: 'Respiration in Organisms', type: 'short', text: 'Why do we get muscle cramps after heavy exercise?', answer: 'During heavy exercise muscles respire anaerobically and lactic acid builds up, which causes cramps.', marks: 2, d: 'Hard' },
    { ch: 'Motion and Time', type: 'mcq', text: 'The basic unit of speed is', options: [['km/min', false], ['m/s', true], ['km/h', false], ['m/min', false]], d: 'Easy' },
    { ch: 'Motion and Time', type: 'short', text: 'A car covers 120 km in 2 hours. What is its speed?', answer: 'Speed = distance ÷ time = 120 km ÷ 2 h = 60 km/h.', marks: 2, d: 'Easy' },
    { ch: 'Motion and Time', type: 'true_false', text: 'The motion of a simple pendulum is an example of periodic motion.', answer: 'true', d: 'Medium' },
    { ch: 'Electric Current and its Effects', type: 'mcq', text: 'An electric fuse works on the', options: [['Magnetic effect of current', false], ['Heating effect of current', true], ['Chemical effect of current', false], ['None of these', false]], d: 'Medium' },
    { ch: 'Electric Current and its Effects', type: 'fill', text: 'A coil of wire that behaves like a magnet when current flows is an ____.', answer: 'electromagnet', d: 'Easy' },
    { ch: 'Light', type: 'mcq', text: 'The image formed by a plane mirror is', options: [['Real and inverted', false], ['Virtual and erect', true], ['Real and erect', false], ['Virtual and inverted', false]], d: 'Medium' },
    { ch: 'Light', type: 'true_false', text: 'A convex lens can form a real image on a screen.', answer: 'true', d: 'Medium' },
    { ch: 'Forests: Our Lifeline', type: 'short', text: 'Why are forests called the lungs of the Earth?', answer: 'Trees take in carbon dioxide and give out oxygen, keeping the balance of these gases in the air.', marks: 2, d: 'Easy' },
    { ch: 'Wastewater Story', type: 'mcq', text: 'Sludge separated during wastewater treatment can be used to make', options: [['Biogas', true], ['Plastic', false], ['Glass', false], ['Paper', false]], d: 'Medium' },
];

// Arithmetic questions for Mathematics, worked out (so every answer is right).
let seed = 8_117;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const shuffle = <T>(xs: T[]) => xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const mcq = (ch: string, text: string, right: string | number, wrong: (string | number)[], d: Q['d'] = 'Easy', explanation?: string): Q => ({
    ch,
    type: 'mcq',
    text,
    options: shuffle([[String(right), true] as [string, boolean], ...[...new Set(wrong.map(String))].filter((w) => w !== String(right)).slice(0, 3).map((w) => [w, false] as [string, boolean])]),
    explanation,
    d,
});

const maths = (): Q[] => {
    const out: Q[] = [];
    for (let i = 0; i < 12; i++) {
        const a = int(-20, 20);
        const b = int(-20, 20);
        const op = i % 3;
        const r = op === 0 ? a + b : op === 1 ? a - b : a * b;
        const show = (n: number) => (n < 0 ? `(${n})` : String(n));
        out.push(mcq('Integers', `What is ${show(a)} ${op === 0 ? '+' : op === 1 ? '−' : '×'} ${show(b)}?`, r, [r + 2, -r, r - 1, r + 10], i > 7 ? 'Medium' : 'Easy'));
    }
    for (let i = 0; i < 8; i++) {
        const p = int(5, 40) * 10;
        const pct = [10, 20, 25, 50][i % 4];
        out.push(mcq('Comparing Quantities', `What is ${pct}% of ${p}?`, (p * pct) / 100, [(p * pct) / 10, p - pct, (p * pct) / 100 + 5, pct], 'Easy'));
    }
    for (let i = 0; i < 8; i++) {
        const cp = int(10, 90) * 10;
        const gain = int(1, 20) * 5;
        out.push(mcq('Comparing Quantities', `A shopkeeper buys an item for ₹${cp} and sells it for ₹${cp + gain}. What is the profit?`, `₹${gain}`, [`₹${cp}`, `₹${cp + gain}`, `₹${gain * 2}`, `₹${gain + 10}`], 'Easy'));
    }
    for (let i = 0; i < 8; i++) {
        const x = int(2, 15);
        const m = int(2, 9);
        const c = int(1, 20);
        out.push(mcq('Simple Equations', `Solve: ${m}x + ${c} = ${m * x + c}`, `x = ${x}`, [`x = ${x + 1}`, `x = ${x - 1}`, `x = ${m}`, `x = ${c}`], 'Medium', `${m}x = ${m * x + c} − ${c} = ${m * x}, so x = ${x}.`));
    }
    for (let i = 0; i < 6; i++) {
        const a = int(20, 80);
        out.push(mcq('Lines and Angles', `What is the complement of ${a}°?`, `${90 - a}°`, [`${180 - a}°`, `${a}°`, `${90 + a}°`, `${100 - a}°`], 'Easy'));
        out.push(mcq('Lines and Angles', `What is the supplement of ${a + 40}°?`, `${140 - a}°`, [`${130 - a}°`, `${a + 40}°`, `${180 + a}°`, `${150 - a}°`], 'Easy'));
    }
    for (let i = 0; i < 6; i++) {
        const a = int(30, 80);
        const b = int(20, 150 - a);
        out.push(mcq('The Triangle and its Properties', `Two angles of a triangle are ${a}° and ${b}°. What is the third angle?`, `${180 - a - b}°`, [`${180 - a}°`, `${90 - b}°`, `${a + b}°`, `${170 - a - b}°`], 'Medium', 'The angles of a triangle add up to 180°.'));
    }
    for (let i = 0; i < 6; i++) {
        const l = int(3, 20);
        const w = int(2, 15);
        out.push(mcq('Perimeter and Area', `A rectangle is ${l} cm long and ${w} cm wide. What is its area?`, `${l * w} cm²`, [`${2 * (l + w)} cm²`, `${l + w} cm²`, `${l * w + 10} cm²`, `${l * w - w} cm²`], 'Easy'));
    }
    for (let i = 0; i < 4; i++) {
        const b = int(2, 5);
        const e = int(2, 4);
        out.push(mcq('Exponents and Powers', `What is the value of ${b}^${e}?`, b ** e, [b * e, b ** e + b, e ** b === b ** e ? b ** e + 1 : e ** b, b + e], 'Easy'));
    }
    out.push(
        { ch: 'Integers', type: 'true_false', text: 'The product of two negative integers is a positive integer.', answer: 'true', d: 'Easy' },
        { ch: 'Rational Numbers', type: 'true_false', text: 'Every integer is a rational number.', answer: 'true', d: 'Medium' },
        { ch: 'Data Handling', type: 'fill', text: 'The value that occurs most often in a set of data is called the ____.', answer: 'mode', d: 'Easy' },
        { ch: 'Data Handling', type: 'short', text: 'Find the mean of 4, 8, 6, 10 and 12.', answer: 'Mean = (4 + 8 + 6 + 10 + 12) ÷ 5 = 40 ÷ 5 = 8.', marks: 2, d: 'Easy' },
        { ch: 'Algebraic Expressions', type: 'fill', text: 'In the term 7xy, the coefficient is ____.', answer: '7', d: 'Easy' },
        { ch: 'Algebraic Expressions', type: 'multi', text: 'Which of these are like terms of 3ab?', options: [['5ab', true], ['−ab', true], ['3a', false], ['ab²', false]], marks: 2, d: 'Medium' },
        { ch: 'Symmetry', type: 'mcq', text: 'How many lines of symmetry does a square have?', options: [['2', false], ['4', true], ['1', false], ['6', false]], d: 'Easy' },
        { ch: 'Visualising Solid Shapes', type: 'mcq', text: 'How many faces does a cube have?', options: [['4', false], ['6', true], ['8', false], ['12', false]], d: 'Easy' },
        { ch: 'Comparing Quantities', type: 'long', text: 'Find the simple interest on ₹5,000 at 8% a year for 3 years, and the amount at the end.', answer: 'SI = P × R × T ÷ 100 = 5000 × 8 × 3 ÷ 100 = ₹1,200. Amount = 5000 + 1200 = ₹6,200.', marks: 3, d: 'Medium' },
        { ch: 'Simple Equations', type: 'long', text: 'The sum of three times a number and 11 is 32. Find the number.', answer: 'Let the number be x. 3x + 11 = 32, so 3x = 21 and x = 7.', marks: 3, d: 'Medium' }
    );
    return out;
};

export const createDemoQuestions = async () => {
    const tenantId = getTenantId()!;
    if (await db.chapter.count({ where: { isDemo: true } })) return { chapters: 0, questions: 0 };
    const [classes, subjects, difficulty] = await Promise.all([db.schoolClass.findMany({ select: { id: true, name: true } }), db.subject.findMany({ select: { id: true, name: true } }), listOptions('question_difficulty')]);
    await listOptions('question_level');
    const classId = new Map(classes.map((c) => [c.name, c.id]));
    const subjectId = new Map(subjects.map((s) => [s.name, s.id]));
    const diff = new Map(difficulty.map((d) => [d.name, d.id]));
    let chapters = 0;
    const chapterId = new Map<string, string>();
    for (const [cls, bySubject] of Object.entries(CHAPTERS))
        for (const [subj, list] of Object.entries(bySubject)) {
            const c = classId.get(cls);
            const s = subjectId.get(subj);
            if (!c || !s) continue;
            let order = 10;
            for (const [name, topics] of list) {
                const row = await db.chapter.upsert({ where: { tenantId_classId_subjectId_name: { tenantId, classId: c, subjectId: s, name } }, update: {}, create: { tenantId, classId: c, subjectId: s, name, topics, sortOrder: order, isDemo: true } });
                chapterId.set(`${cls}|${subj}|${name}`, row.id);
                order += 10;
                chapters++;
            }
        }
    // Teachers of Class VII write them.
    const vii = classId.get('Class VII');
    const authors = vii ? await db.teachingAssignment.findMany({ where: { section: { classId: vii } }, select: { subjectId: true, staff: { select: { userId: true } } } }) : [];
    const authorOf = (subj: string) => authors.find((a) => a.subjectId === subjectId.get(subj) && a.staff.userId)?.staff.userId ?? null;
    const rows: Prisma.QuestionCreateManyInput[] = [];
    for (const [subj, list] of [['Science', SCIENCE], ['Mathematics', maths()]] as const) {
        const s = subjectId.get(subj);
        if (!vii || !s) continue;
        list.forEach((q, i) => {
            // Most approved; some waiting for review; some AI drafts.
            const status = i % 17 === 5 ? 'pending' : i % 19 === 7 ? 'draft' : 'approved';
            rows.push({
                tenantId,
                classId: vii,
                subjectId: s,
                chapterId: chapterId.get(`Class VII|${subj}|${q.ch}`) ?? null,
                type: q.type,
                text: q.text,
                options: (q.options ?? []).map(([text, correct]) => ({ text, correct })) as Prisma.InputJsonValue,
                answer: q.answer ?? null,
                explanation: q.explanation ?? null,
                marks: q.marks ?? 1,
                difficultyId: q.d ? (diff.get(q.d) ?? null) : null,
                status,
                source: status === 'draft' ? 'ai' : 'manual',
                createdBy: authorOf(subj),
                isDemo: true,
            });
        });
    }
    if (rows.length) await db.question.createMany({ data: rows });
    return { chapters, questions: rows.length };
};

export const clearDemoQuestions = async () => {
    await db.question.deleteMany({ where: { isDemo: true } });
    await db.chapter.deleteMany({ where: { isDemo: true, NOT: { id: { in: (await db.question.findMany({ where: { chapterId: { not: null } }, select: { chapterId: true } })).map((q) => q.chapterId!) } } } });
};
