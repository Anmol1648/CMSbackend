import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { runAsTenant } from '../src/core/context';
import { clearDemoData, createDemoData } from '../src/modules/students/demo-data';
import { makeTenant, resetDatabase } from './helpers';

let alpha: Awaited<ReturnType<typeof makeTenant>>;
const inAlpha = <T>(fn: () => Promise<T>) => runAsTenant(alpha.tenant.id, fn);

beforeAll(async () => {
    await resetDatabase();
    alpha = await makeTenant('alpha', 'Alpha School', 'alpha.test.in', { starterData: true });
}, 240_000);

describe('demo data', () => {
    it('fills every section with students, parents, class teachers and roll numbers', async () => {
        const r = await inAlpha(() => createDemoData({ perSection: [2, 3] }));
        expect(r.students).toBeGreaterThanOrEqual(64);
        expect(r.studentLogins).toBe(r.students);
        const sections = await inAlpha(() => db.section.findMany({ include: { enrolments: true } }));
        expect(sections.every((s) => s.classTeacherId && s.enrolments.length >= 2)).toBe(true);
        expect(sections.every((s) => s.enrolments.filter((e) => e.rollNumber).length > 0)).toBe(true);
        const guardians = await inAlpha(() => db.guardian.count());
        expect(guardians).toBe(r.families * 2);
        // Admission enquiries at every stage; the converted ones point at students of their class.
        expect(r.enquiries.enquiries).toBe(150);
        const converted = await inAlpha(() => db.enquiry.findMany({ where: { studentId: { not: null } }, include: { student: { include: { enrolments: { include: { section: true } } } } } }));
        expect(converted.length).toBe(r.enquiries.converted);
        expect(converted.every((e) => e.student!.enrolments[0].section.classId === e.classId)).toBe(true);
        await expect(inAlpha(() => createDemoData())).rejects.toThrow('already has demo data');
    }, 300_000);

    it('removes all of it again, and admission numbers start over', async () => {
        const r = await inAlpha(clearDemoData);
        expect(r.counterReset).toBe(true);
        expect(await inAlpha(() => db.student.count())).toBe(0);
        expect(await inAlpha(() => db.enquiry.count())).toBe(0);
        expect(await inAlpha(() => db.family.count())).toBe(0);
        expect(await inAlpha(() => db.user.count({ where: { isDemo: true } }))).toBe(0);
        expect(await inAlpha(() => db.section.count({ where: { classTeacherId: { not: null } } }))).toBe(0);
    }, 120_000);
});
