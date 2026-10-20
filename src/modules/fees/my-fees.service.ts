import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { currentYear } from '../academic/years.service';
import { fullName } from '../students/students.service';
import { FEES } from './fees.settings';
import { computeDues, dueStudents } from './dues.service';
import { getReceipt } from './receipts.service';

/** "My Fees": a student's own fees, or a parent's children's, with online payment when it is on. */

const mine = (userId: string) => ({ OR: [{ userId }, { family: { guardians: { some: { userId } } } }] });

export const myFees = async (userId: string) => {
    const year = await currentYear();
    const s = await getSettings({ online: FEES.onlineFees, partial: FEES.partialPayment, minimum: FEES.minimumOnline, convenienceMode: FEES.convenienceMode, convenienceValue: FEES.convenienceValue });
    const gateway = await db.paymentGateway.findFirst({ select: { provider: true, keyId: true, keySecretEnc: true } });
    const gatewayReady = !!gateway && (gateway.provider === 'mock' || (!!gateway.keyId && !!gateway.keySecretEnc));
    if (!year) return { academicYear: null, online: { enabled: false }, children: [] };
    const students = await dueStudents(year.id, { ...mine(userId), status: 'active' });
    const dues = await computeDues(year.id, students);
    const info = await db.student.findMany({
        where: { id: { in: students.map((x) => x.id) } },
        select: {
            id: true,
            admissionNo: true,
            firstName: true,
            middleName: true,
            lastName: true,
            enrolments: { where: { academicYearId: year.id }, select: { section: { select: { name: true, schoolClass: { select: { name: true, shortName: true } } } } } },
            feeReceipts: { where: { academicYearId: year.id }, select: { id: true, receiptNo: true, date: true, amount: true, mode: true, status: true }, orderBy: { date: 'desc' } },
        },
        orderBy: { firstName: 'asc' },
    });
    return {
        academicYear: { id: year.id, name: year.name },
        online: {
            enabled: s.online && gatewayReady,
            provider: gatewayReady ? gateway!.provider : null,
            partial: s.partial,
            minimum: s.minimum,
            convenience: { mode: s.convenienceMode, value: s.convenienceValue },
        },
        children: info.map((c) => {
            const e = c.enrolments[0];
            return {
                id: c.id,
                name: fullName(c),
                admissionNo: c.admissionNo,
                section: e ? `${e.section.schoolClass.shortName ?? e.section.schoolClass.name}-${e.section.name}` : null,
                dues: dues.get(c.id)!,
                receipts: c.feeReceipts.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10) })),
            };
        }),
    };
};

/** A receipt of one's own child (or oneself). */
export const myReceipt = (userId: string, receiptId: string) => getReceipt(receiptId, { userId, scope: 'own' });
