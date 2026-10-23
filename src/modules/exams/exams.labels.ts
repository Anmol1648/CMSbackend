import { db } from '../../core/db';
import { getSettings } from '../../core/settings';
import { listOptions } from '../masters/masters.service';
import { registerMasterUsage } from '../masters/masters.registry';
import { EXAMS } from './exams.settings';

/**
 * What a school calls things in exams (System Settings → Exams) and its mark statuses
 * (Masters → Exams → Mark statuses). Marks keep the status code; “P” is always present.
 */

export type MarkCounts = 'zero' | 'leave_out' | 'average';
const KEY = 'exam_mark_status';

/** Every status (inactive ones too, so old marks still read), by code. */
export const markStatuses = async () => {
    await listOptions(KEY); // fills the list with its starter statuses the first time
    const rows = await db.masterValue.findMany({ where: { master: KEY }, select: { code: true, name: true, isActive: true, extra: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    return rows
        .filter((r) => r.code && r.code.toUpperCase() !== 'P')
        .map((r) => ({ code: r.code!.toUpperCase(), name: r.name, active: r.isActive, counts: (((r.extra ?? {}) as Record<string, unknown>).counts ?? 'leave_out') as MarkCounts }));
};

export const examLabels = async () => {
    const s = await getSettings({
        present: EXAMS.presentName,
        draft: EXAMS.draftName,
        open: EXAMS.openName,
        locked: EXAMS.lockedName,
        published: EXAMS.publishedName,
        final: EXAMS.finalName,
        marks: EXAMS.marksKindName,
        descriptive: EXAMS.descriptiveKindName,
        lockBeforePublish: EXAMS.lockBeforePublish,
    });
    return {
        present: s.present,
        stages: { draft: s.draft, open: s.open, locked: s.locked, published: s.published },
        finalName: s.final,
        kinds: { marks: s.marks, descriptive: s.descriptive },
        lockBeforePublish: s.lockBeforePublish,
        statuses: await markStatuses(),
    };
};

registerMasterUsage(KEY, {
    label: 'marks',
    count: async (ids) => {
        const codes = (await db.masterValue.findMany({ where: { id: { in: ids } }, select: { code: true } })).flatMap((r) => (r.code ? [r.code.toUpperCase()] : []));
        return codes.length ? db.examMark.count({ where: { status: { in: codes } } }) : 0;
    },
});
