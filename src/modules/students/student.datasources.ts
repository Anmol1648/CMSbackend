import type { DataScope } from '@prisma/client';
import { db } from '../../core/db';
import { getUserAccess } from '../rbac/access.service';
import { defineDataSource, isoDay, personName, titleCase, yearsSince } from '../reports/datasources.registry';
import { scopeWhere } from './students.service';

/** Students for the Report Builder: one row per student, with their class in the chosen session and family. */

const name = { select: { name: true } } as const;

defineDataSource({
    key: 'students',
    label: 'Students',
    description: 'Every student with their class and roll in a session, personal details, address and parents.',
    category: 'Students',
    permissions: ['student.view'],
    sensitivePermission: 'student.view_sensitive',
    params: [{ key: 'year', label: 'Session', type: 'year', required: true, default: 'current', help: 'Class, section and roll are those of this session.' }],
    fields: [
        { key: 'admissionNo', label: 'Admission no.', type: 'text' },
        { key: 'name', label: 'Student name', type: 'text' },
        { key: 'firstName', label: 'First name', type: 'text' },
        { key: 'lastName', label: 'Last name', type: 'text' },
        { key: 'className', label: 'Class', type: 'text', group: 'Class' },
        { key: 'section', label: 'Class and section', type: 'text', group: 'Class' },
        { key: 'roll', label: 'Roll no.', type: 'number', group: 'Class' },
        { key: 'classTeacher', label: 'Class teacher', type: 'text', group: 'Class' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'admissionDate', label: 'Admission date', type: 'date' },
        { key: 'admissionType', label: 'Admission type', type: 'text' },
        { key: 'gender', label: 'Gender', type: 'text', group: 'Personal' },
        { key: 'dateOfBirth', label: 'Date of birth', type: 'date', group: 'Personal' },
        { key: 'age', label: 'Age (years)', type: 'number', group: 'Personal' },
        { key: 'category', label: 'Category', type: 'text', group: 'Personal' },
        { key: 'casteCategory', label: 'Caste category', type: 'text', group: 'Personal' },
        { key: 'religion', label: 'Religion', type: 'text', group: 'Personal' },
        { key: 'motherTongue', label: 'Mother tongue', type: 'text', group: 'Personal' },
        { key: 'nationality', label: 'Nationality', type: 'text', group: 'Personal' },
        { key: 'bloodGroup', label: 'Blood group', type: 'text', group: 'Personal' },
        { key: 'disability', label: 'Disability', type: 'text', group: 'Personal' },
        { key: 'aadhaar', label: 'Aadhaar', type: 'text', group: 'Personal', sensitive: true },
        { key: 'apaarId', label: 'APAAR ID', type: 'text', group: 'Personal' },
        { key: 'pen', label: 'PEN (UDISE+)', type: 'text', group: 'Personal' },
        { key: 'medicalNotes', label: 'Medical notes', type: 'text', group: 'Personal', sensitive: true },
        { key: 'mobile', label: 'Student mobile', type: 'text', group: 'Contact' },
        { key: 'email', label: 'Student email', type: 'text', group: 'Contact' },
        { key: 'address', label: 'Address', type: 'text', group: 'Contact' },
        { key: 'city', label: 'City / town', type: 'text', group: 'Contact' },
        { key: 'district', label: 'District', type: 'text', group: 'Contact' },
        { key: 'state', label: 'State', type: 'text', group: 'Contact' },
        { key: 'pinCode', label: 'PIN code', type: 'text', group: 'Contact' },
        { key: 'emergencyName', label: 'Emergency contact', type: 'text', group: 'Contact' },
        { key: 'emergencyPhone', label: 'Emergency phone', type: 'text', group: 'Contact' },
        { key: 'father', label: 'Father', type: 'text', group: 'Family' },
        { key: 'fatherMobile', label: 'Father’s mobile', type: 'text', group: 'Family' },
        { key: 'fatherOccupation', label: 'Father’s occupation', type: 'text', group: 'Family' },
        { key: 'mother', label: 'Mother', type: 'text', group: 'Family' },
        { key: 'motherMobile', label: 'Mother’s mobile', type: 'text', group: 'Family' },
        { key: 'motherOccupation', label: 'Mother’s occupation', type: 'text', group: 'Family' },
        { key: 'guardian', label: 'Main contact (parent)', type: 'text', group: 'Family' },
        { key: 'guardianRelation', label: 'Main contact’s relation', type: 'text', group: 'Family' },
        { key: 'guardianMobile', label: 'Main contact’s mobile', type: 'text', group: 'Family' },
        { key: 'guardianEmail', label: 'Main contact’s email', type: 'text', group: 'Family' },
        { key: 'familyIncome', label: 'Family income range', type: 'text', group: 'Family' },
        { key: 'previousSchool', label: 'Previous school', type: 'text', group: 'Previous school' },
        { key: 'previousClass', label: 'Previous class', type: 'text', group: 'Previous school' },
        { key: 'previousBoard', label: 'Previous board', type: 'text', group: 'Previous school' },
        { key: 'tcNumber', label: 'TC number (previous school)', type: 'text', group: 'Previous school' },
        { key: 'leftOn', label: 'Left / status date', type: 'date' },
        { key: 'leavingReason', label: 'Leaving reason', type: 'text' },
        { key: 'hasLogin', label: 'Has a login', type: 'boolean' },
    ],
    async load(p, ctx) {
        const access = await getUserAccess(ctx.userId);
        const scope = await scopeWhere({ userId: ctx.userId, scope: (access.permissions['student.view'] ?? 'own') as DataScope, sensitive: ctx.sensitive });
        const students = await db.student.findMany({
            where: scope,
            include: {
                admissionType: name, gender: name, bloodGroup: name, religion: name, casteCategory: name, motherTongue: name, nationality: name, disability: name, category: name,
                state: name, district: name, city: name, previousBoard: name, leavingReason: name,
                enrolments: {
                    where: { academicYearId: p.year },
                    select: { rollNumber: true, section: { select: { name: true, sortOrder: true, classTeacher: { select: { firstName: true, middleName: true, lastName: true } }, schoolClass: { select: { name: true, shortName: true, sortOrder: true } } } } },
                },
                family: { select: { guardians: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], select: { name: true, mobile: true, email: true, isPrimary: true, relation: name, occupation: name, incomeRange: name } } } },
            },
        });
        const rows = students.map((s) => {
            const e = s.enrolments[0];
            const g = s.family?.guardians ?? [];
            const byRelation = (word: string) => g.find((x) => x.relation?.name.toLowerCase().includes(word));
            const father = byRelation('father');
            const mother = byRelation('mother');
            const main = g.find((x) => x.isPrimary) ?? g[0];
            return {
                _id: s.id,
                order: e ? e.section.schoolClass.sortOrder * 1000 + e.section.sortOrder : 1e9,
                admissionNo: s.admissionNo,
                name: personName(s),
                firstName: s.firstName,
                lastName: s.lastName,
                className: e?.section.schoolClass.name ?? null,
                section: e ? `${e.section.schoolClass.shortName ?? e.section.schoolClass.name}-${e.section.name}` : null,
                roll: e?.rollNumber ?? null,
                classTeacher: personName(e?.section.classTeacher),
                status: titleCase(s.status),
                admissionDate: isoDay(s.admissionDate),
                admissionType: s.admissionType?.name ?? null,
                gender: s.gender?.name ?? null,
                dateOfBirth: isoDay(s.dateOfBirth),
                age: yearsSince(s.dateOfBirth),
                category: s.category?.name ?? null,
                casteCategory: s.casteCategory?.name ?? null,
                religion: s.religion?.name ?? null,
                motherTongue: s.motherTongue?.name ?? null,
                nationality: s.nationality?.name ?? null,
                bloodGroup: s.bloodGroup?.name ?? null,
                disability: s.disability?.name ?? null,
                aadhaar: s.aadhaar,
                apaarId: s.apaarId,
                pen: s.pen,
                medicalNotes: s.medicalNotes,
                mobile: s.mobile,
                email: s.email,
                address: s.addressLine,
                city: s.city?.name ?? null,
                district: s.district?.name ?? null,
                state: s.state?.name ?? null,
                pinCode: s.pinCode,
                emergencyName: s.emergencyName,
                emergencyPhone: s.emergencyPhone,
                father: father?.name ?? null,
                fatherMobile: father?.mobile ?? null,
                fatherOccupation: father?.occupation?.name ?? null,
                mother: mother?.name ?? null,
                motherMobile: mother?.mobile ?? null,
                motherOccupation: mother?.occupation?.name ?? null,
                guardian: main?.name ?? null,
                guardianRelation: main?.relation?.name ?? null,
                guardianMobile: main?.mobile ?? null,
                guardianEmail: main?.email ?? null,
                familyIncome: main?.incomeRange?.name ?? null,
                previousSchool: s.previousSchool,
                previousClass: s.previousClass,
                previousBoard: s.previousBoard?.name ?? null,
                tcNumber: s.tcNumber,
                leftOn: isoDay(s.statusDate),
                leavingReason: s.leavingReason?.name ?? null,
                hasLogin: !!s.userId,
            };
        });
        // Class order, then roll, then name: the order people expect before they choose their own.
        return rows
            .sort((a, b) => a.order - b.order || (a.roll ?? 9999) - (b.roll ?? 9999) || String(a.name).localeCompare(String(b.name)))
            .map(({ order: _o, ...r }) => r);
    },
});
