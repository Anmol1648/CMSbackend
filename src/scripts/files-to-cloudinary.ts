/**
 * Copies the files kept on this machine's disk (STORAGE_PROVIDER=local) to Cloudinary, and points
 * their rows there, so every server using the same database can show them. Local copies are kept.
 * Files whose bytes aren't on this machine are listed (upload those again).
 *
 *   npm run files:to-cloudinary
 */
import '../config/env';
import { db } from '../core/db';
import { runAsSystem } from '../core/context';
import { storageFor } from '../core/files/storage';

const out = (line = '') => process.stdout.write(line + '\n');

const main = async () => {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        out('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env first.');
        process.exitCode = 1;
        return;
    }
    const local = storageFor('local');
    const cloud = storageFor('cloudinary');
    const files = await runAsSystem(() => db.file.findMany({ where: { provider: 'local', deletedAt: null }, select: { id: true, storageKey: true, mimeType: true, purpose: true, originalName: true } }));
    let moved = 0;
    const missing: string[] = [];
    for (const f of files) {
        let data: Buffer;
        try {
            data = await local.get(f.storageKey);
        } catch {
            missing.push(`${f.purpose}: ${f.originalName}`);
            continue;
        }
        const key = await cloud.put(f.storageKey, data, f.mimeType);
        await runAsSystem(() => db.file.update({ where: { id: f.id }, data: { provider: 'cloudinary', storageKey: key } }));
        moved++;
    }
    out(`${moved} of ${files.length} files copied to Cloudinary.`);
    if (missing.length) {
        out(`${missing.length} not on this machine (upload them again):`);
        for (const m of missing) out(`  ${m}`);
    }
};

main()
    .catch((err) => {
        out(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
