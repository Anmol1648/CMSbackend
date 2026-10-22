import type { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { defineDataSource, isoDay, personName, yearsSince } from '../reports/datasources.registry';
import { modeNames } from '../fees/payment-modes';
import { testResultNames } from './test-results';

/** Admission enquiries for the Report Builder: one row per enquiry. */

const name = { select: { name: true } } as const;

defineDataSource({
    key: 'enquiries',
    label: 'Admission enquiries',
    description: 'Every enquiry in a period: the child, parent and number, where it came from, where it stands, registration and test.',
    category: 'Admissions',
    permissions: ['enquiry.reports', 'enquiry.view'],
    params: [
        { key: 'from', label: 'Enquiries from', type: 'date', required: true, default: 'sessionStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
    ],
    fields: [
        { key: 'enquiryNo', label: 'Enquiry no.', type: 'text' },
        { key: 'date', label: 'Enquiry date', type: 'date' },
        { key: 'session', label: 'Session applied for', type: 'text' },
        { key: 'className', label: 'Class applied for', type: 'text' },
        { key: 'student', label: 'Child’s name', type: 'text', group: 'Child' },
        { key: 'dateOfBirth', label: 'Date of birth', type: 'date', group: 'Child' },
        { key: 'age', label: 'Age (years)', type: 'number', group: 'Child' },
        { key: 'gender', label: 'Gender', type: 'text', group: 'Child' },
        { key: 'currentSchool', label: 'Current school', type: 'text', group: 'Child' },
        { key: 'parent', label: 'Parent', type: 'text', group: 'Parent' },
        { key: 'relation', label: 'Relation', type: 'text', group: 'Parent' },
        { key: 'mobile', label: 'Mobile', type: 'text', group: 'Parent' },
        { key: 'email', label: 'Email', type: 'text', group: 'Parent' },
        { key: 'area', label: 'Area', type: 'text', group: 'Parent' },
        { key: 'source', label: 'Source', type: 'text', group: 'Follow-up' },
        { key: 'online', label: 'Came through the website', type: 'boolean', group: 'Follow-up' },
        { key: 'stage', label: 'Stage', type: 'text', group: 'Follow-up' },
        { key: 'assignedTo', label: 'Followed up by', type: 'text', group: 'Follow-up' },
        { key: 'nextFollowUp', label: 'Next follow-up', type: 'date', group: 'Follow-up' },
        { key: 'followUps', label: 'Follow-ups made', type: 'number', group: 'Follow-up' },
        { key: 'lostReason', label: 'Lost reason', type: 'text', group: 'Follow-up' },
        { key: 'remarks', label: 'Remarks', type: 'text', group: 'Follow-up' },
        { key: 'registrationNo', label: 'Registration no.', type: 'text', group: 'Registration and test' },
        { key: 'registrationDate', label: 'Registration date', type: 'date', group: 'Registration and test' },
        { key: 'registrationFee', label: 'Registration fee', type: 'money', group: 'Registration and test' },
        { key: 'registrationFeeMode', label: 'Registration fee paid by', type: 'text', group: 'Registration and test' },
        { key: 'testDate', label: 'Test date', type: 'date', group: 'Registration and test' },
        { key: 'testScore', label: 'Test score', type: 'text', group: 'Registration and test' },
        { key: 'testResult', label: 'Test result', type: 'text', group: 'Registration and test' },
        { key: 'admitted', label: 'Admitted', type: 'boolean', group: 'Registration and test' },
        { key: 'admittedOn', label: 'Admitted on', type: 'date', group: 'Registration and test' },
    ],
    async load(p, ctx) {
        if (p.from > p.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const access = await getUserAccess(ctx.userId);
        const where: Prisma.EnquiryWhereInput = {
            enquiryDate: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) },
            ...(access.permissions['enquiry.view'] === 'all' || (!access.permissions['enquiry.view'] && access.permissions['enquiry.reports']) ? {} : { assignedTo: { userId: ctx.userId } }),
        };
        const list = await db.enquiry.findMany({
            where,
            orderBy: [{ enquiryDate: 'asc' }, { enquiryNo: 'asc' }],
            include: {
                academicYear: name, schoolClass: name, gender: name, relation: name, source: name, stage: name, lostReason: name,
                assignedTo: { select: { firstName: true, middleName: true, lastName: true } },
                _count: { select: { followUps: true } },
            },
        });
        const modeName = await modeNames();
        const testName = await testResultNames();
        return list.map((e) => ({
            enquiryNo: e.enquiryNo,
            date: isoDay(e.enquiryDate),
            session: e.academicYear.name,
            className: e.schoolClass.name,
            student: [e.studentFirstName, e.studentLastName].filter(Boolean).join(' '),
            dateOfBirth: isoDay(e.dateOfBirth),
            age: yearsSince(e.dateOfBirth),
            gender: e.gender?.name ?? null,
            currentSchool: e.currentSchool,
            parent: e.parentName,
            relation: e.relation?.name ?? null,
            mobile: e.mobile,
            email: e.email,
            area: e.area,
            source: e.source?.name ?? null,
            online: e.online,
            stage: e.stage.name,
            assignedTo: personName(e.assignedTo),
            nextFollowUp: isoDay(e.nextFollowUp),
            followUps: e._count.followUps,
            lostReason: e.lostReason?.name ?? null,
            remarks: e.remarks,
            registrationNo: e.registrationNo,
            registrationDate: isoDay(e.registrationDate),
            registrationFee: e.registrationFee,
            registrationFeeMode: e.registrationFeeMode ? modeName(e.registrationFeeMode) : null,
            testDate: isoDay(e.testDate),
            testScore: e.testScore,
            testResult: testName(e.testResult),
            admitted: !!e.studentId,
            admittedOn: isoDay(e.convertedAt),
        }));
    },
});
