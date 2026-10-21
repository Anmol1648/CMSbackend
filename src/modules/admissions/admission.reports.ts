import type { Prisma } from '@prisma/client';
import { db } from '../../core/db';
import { badRequest } from '../../core/errors';
import { getUserAccess } from '../rbac/access.service';
import { defineReport } from '../reports/reports.registry';

/** Admission reports in the Report Center. */

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const person = (p: { firstName: string; middleName?: string | null; lastName?: string | null } | null) => (p ? [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ') : '');

defineReport({
    key: 'enquiry_register',
    category: 'Admissions',
    label: 'Enquiry register',
    description: 'Every admission enquiry in a period: class, parent and number, source, where it stands and the next follow-up, grouped by stage, source or class.',
    permissions: ['enquiry.reports'],
    orientation: 'landscape',
    filters: [
        { key: 'from', label: 'From', type: 'date', required: true, default: 'sessionStart' },
        { key: 'to', label: 'To', type: 'date', required: true, default: 'today' },
        {
            key: 'groupBy',
            label: 'Group by',
            type: 'select',
            default: 'stage',
            options: [
                { value: 'stage', label: 'Stage' },
                { value: 'source', label: 'Source' },
                { value: 'class', label: 'Class applied for' },
                { value: 'none', label: 'No grouping' },
            ],
        },
        { key: 'class', label: 'Class applied for', type: 'class' },
    ],
    columns: [
        { key: 'enquiryNo', label: 'Enquiry no.', type: 'text', width: 1.1 },
        { key: 'date', label: 'Date', type: 'date', width: 0.9 },
        { key: 'student', label: 'Student', type: 'text', width: 1.6 },
        { key: 'className', label: 'Class', type: 'text', width: 0.8 },
        { key: 'parent', label: 'Parent', type: 'text', width: 1.5 },
        { key: 'mobile', label: 'Mobile', type: 'text', width: 1 },
        { key: 'source', label: 'Source', type: 'text', width: 1 },
        { key: 'stage', label: 'Stage', type: 'text', width: 1 },
        { key: 'assignedTo', label: 'Followed up by', type: 'text', width: 1.3 },
        { key: 'nextFollowUp', label: 'Next follow-up', type: 'date', width: 0.9 },
    ],
    async run(f, ctx) {
        if (f.from > f.to) throw badRequest('“From” is after “to”', [{ field: 'from', message: 'is after “to”' }]);
        const access = await getUserAccess(ctx.userId);
        const where: Prisma.EnquiryWhereInput = {
            enquiryDate: { gte: new Date(`${f.from}T00:00:00Z`), lte: new Date(`${f.to}T00:00:00Z`) },
            ...(access.permissions['enquiry.view'] === 'all' ? {} : { assignedTo: { userId: ctx.userId } }),
            ...(f.class ? { classId: f.class } : {}),
        };
        const list = await db.enquiry.findMany({
            where,
            select: {
                enquiryNo: true,
                enquiryDate: true,
                studentFirstName: true,
                studentLastName: true,
                parentName: true,
                mobile: true,
                nextFollowUp: true,
                schoolClass: { select: { name: true, sortOrder: true } },
                source: { select: { name: true, sortOrder: true } },
                stage: { select: { name: true, sortOrder: true } },
                assignedTo: { select: { firstName: true, middleName: true, lastName: true } },
            },
            orderBy: [{ enquiryDate: 'asc' }, { enquiryNo: 'asc' }],
        });
        const pad = (n: number | undefined) => String(n ?? 9999).padStart(5, '0');
        const rows = list
            .map((e) => {
                const group =
                    f.groupBy === 'stage' ? { groupKey: `${pad(e.stage.sortOrder)}${e.stage.name}`, groupLabel: e.stage.name }
                    : f.groupBy === 'source' ? { groupKey: e.source ? `${pad(e.source.sortOrder)}${e.source.name}` : '99999', groupLabel: e.source?.name ?? 'Not recorded' }
                    : f.groupBy === 'class' ? { groupKey: `${pad(e.schoolClass.sortOrder)}${e.schoolClass.name}`, groupLabel: e.schoolClass.name }
                    : { groupKey: '', groupLabel: null };
                return {
                    enquiryNo: e.enquiryNo,
                    date: iso(e.enquiryDate),
                    student: [e.studentFirstName, e.studentLastName].filter(Boolean).join(' '),
                    className: e.schoolClass.name,
                    parent: e.parentName,
                    mobile: e.mobile,
                    source: e.source?.name ?? '',
                    stage: e.stage.name,
                    assignedTo: person(e.assignedTo),
                    nextFollowUp: iso(e.nextFollowUp),
                    ...group,
                };
            })
            .sort((a, b) => a.groupKey.localeCompare(b.groupKey) || String(a.date).localeCompare(String(b.date)));
        const classLabel = f.class ? (await db.schoolClass.findUnique({ where: { id: f.class }, select: { name: true } }))?.name : null;
        return {
            rows,
            subtitle: [f.from === f.to ? day(f.from) : `${day(f.from)} – ${day(f.to)}`, classLabel].filter(Boolean).join(' · '),
            groupedBy: { stage: 'Stage', source: 'Source', class: 'Class applied for' }[f.groupBy as 'stage'] ?? null,
        };
    },
});
