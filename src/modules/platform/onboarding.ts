import { z } from 'zod';
import { db } from '../../core/db';
import { getTenantId } from '../../core/context';
import { defineSetting, getSettings, setSetting } from '../../core/settings';
import { findTenantById } from '../tenants';
import { hasModule } from './catalogue';

/**
 * Setting up a new school: the steps, each worked out from what is already entered (nothing to tick
 * by hand except "go live"). Shown to the school's admin until it is live, and in the console.
 */

export const ONBOARDING = {
    liveOn: defineSetting<string>({ key: 'onboarding.live_on', group: 'School', label: 'onboarding.live_on', type: 'text', default: '', schema: z.string().max(20), hidden: true }),
};

export interface SetupStep {
    key: string;
    label: string;
    help: string;
    href: string;
    done: boolean;
    detail?: string;
}

export const setupProgress = async () => {
    const tenant = await findTenantById(getTenantId()!);
    const fees = tenant ? hasModule(tenant, 'fees') : true;
    const year = await db.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
    const [profile, classes, sections, subjects, feeLines, staff, students, staffLogins, parents, { liveOn }] = await Promise.all([
        db.schoolProfile.findFirst({ select: { legalName: true, logoFileId: true, phone: true, email: true, addressLine1: true } }),
        db.schoolClass.count(),
        year ? db.section.count({ where: { academicYearId: year.id } }) : 0,
        db.subject.count(),
        fees ? db.feeStructureLine.count() : 0,
        db.staff.count({ where: { status: 'working' } }),
        db.student.count({ where: { status: 'active' } }),
        db.user.count({ where: { kind: 'staff', status: 'active' } }),
        db.user.count({ where: { kind: 'guardian', status: 'active' } }),
        getSettings({ liveOn: ONBOARDING.liveOn }),
    ]);
    const steps: SetupStep[] = [
        { key: 'profile', label: 'School profile and logo', help: 'Name, address, phone, email and logo: shown on receipts, report cards and the login page.', href: '/school-profile', done: !!(profile?.logoFileId && profile.phone && profile.email && profile.addressLine1), detail: profile?.logoFileId ? undefined : 'No logo yet' },
        { key: 'session', label: 'Academic session', help: 'The current session (e.g. 2026-27) and its terms.', href: '/academic', done: !!year, detail: year?.name },
        { key: 'classes', label: 'Classes and sections', help: 'Classes, and the sections of each in this session.', href: '/academic', done: classes > 0 && sections > 0, detail: `${classes} classes, ${sections} sections` },
        { key: 'subjects', label: 'Subjects', help: 'Subjects, and which classes take them.', href: '/academic/subjects', done: subjects > 0, detail: `${subjects} subjects` },
        ...(fees ? [{ key: 'fees', label: 'Fee structure', help: 'Fee heads, instalments and the amount for each class.', href: '/fees/setup', done: feeLines > 0, detail: feeLines ? undefined : 'Not set up' }] : []),
        { key: 'staff', label: 'Staff', help: 'Add staff one by one or import them from Excel.', href: '/staff', done: staff >= 3, detail: `${staff} staff` },
        { key: 'students', label: 'Students', help: 'Admit students or import them from Excel.', href: '/students', done: students > 0, detail: `${students} students` },
        { key: 'logins', label: 'Staff logins and roles', help: 'Give staff logins and check what each role may do (Users, Roles & Permissions).', href: '/users', done: staffLogins >= 2, detail: `${staffLogins} staff logins` },
        { key: 'parents', label: 'Parent logins', help: 'Create parent logins (optional): they see fees, attendance, results and notices.', href: '/students', done: parents > 0, detail: `${parents} parent logins` },
    ];
    const done = steps.filter((s) => s.done).length;
    return { steps, done, total: steps.length, live: !!liveOn, liveOn: liveOn || null };
};

/** The school says it is ready (the checklist then stops showing). */
export const goLive = async (userId: string) => {
    await setSetting(ONBOARDING.liveOn, new Date().toISOString().slice(0, 10), userId);
    return setupProgress();
};
