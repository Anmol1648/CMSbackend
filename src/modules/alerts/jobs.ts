import { db } from '../../core/db';
import { getTenantId, runAsSystem, runAsTenant } from '../../core/context';
import { getSettings } from '../../core/settings';
import { logger } from '../../core/logger';
import { minutesIST, todayIST } from '../attendance/attendance.settings';
import { ALERTS } from './alerts.settings';
import { onQueuePass } from './queue';

/**
 * Daily jobs: each runs once a day per school, after its time (school time): fee reminders,
 * absent streaks, pending sheets, follow-ups… Modules declare theirs with defineDailyJob.
 */

export interface DailyJob {
    key: string;
    /** "HH:MM" it runs after (default: System Settings → Alerts → daily time). */
    at?: () => Promise<string>;
    /** Returns a short result for the log ("12 parents"). */
    run: () => Promise<string>;
}

const jobs: DailyJob[] = [];
export const defineDailyJob = (job: DailyJob) => {
    if (jobs.some((j) => j.key === job.key)) throw new Error(`Daily job "${job.key}" is defined twice`);
    jobs.push(job);
};
export const listDailyJobs = () => [...jobs];

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Runs one job now (also "Run now" on the screen); records the day so it isn't run again. */
export const runJob = async (job: DailyJob, force = false) => {
    const day = new Date(`${todayIST()}T00:00:00Z`);
    if (!force) {
        try {
            await db.jobRun.create({ data: { tenantId: getTenantId()!, key: job.key, day } });
        } catch {
            return null; // already ran today (or another server took it)
        }
    }
    try {
        const result = await job.run();
        if (!force) await db.jobRun.updateMany({ where: { key: job.key, day }, data: { result } });
        return result;
    } catch (err) {
        const msg = `failed: ${(err as Error).message}`.slice(0, 300);
        if (!force) await db.jobRun.updateMany({ where: { key: job.key, day }, data: { result: msg } });
        logger.error('Daily alert job failed', { job: job.key, error: (err as Error).message });
        return msg;
    }
};

const forSchool = async () => {
    const { at } = await getSettings({ at: ALERTS.dailyTime });
    const now = minutesIST();
    const day = new Date(`${todayIST()}T00:00:00Z`);
    const done = new Set((await db.jobRun.findMany({ where: { day }, select: { key: true } })).map((r) => r.key));
    for (const job of jobs) {
        if (done.has(job.key)) continue;
        const time = job.at ? await job.at() : at;
        if (now >= minutesOf(time)) await runJob(job);
    }
};

/** Old notifications and log entries go after the days each school keeps them. */
const purge = async () => {
    const s = await getSettings({ keepNotifications: ALERTS.keepNotifications, keepLog: ALERTS.keepLog });
    await db.notification.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - s.keepNotifications * 86_400_000) } } });
    await db.messageDelivery.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - s.keepLog * 86_400_000) }, status: { in: ['sent', 'failed', 'skipped'] } } });
    return 'cleaned';
};
defineDailyJob({ key: 'alerts_cleanup', at: async () => '02:00', run: purge });

onQueuePass(async () => {
    const tenants = await runAsSystem(() => db.tenant.findMany({ where: { status: 'active' }, select: { id: true } }));
    for (const t of tenants) await runAsTenant(t.id, forSchool);
});
