/**
 * Checks that the backend can reach and sign in to the mail server. Sends nothing.
 *   npx tsx scripts/check-smtp.ts
 */
import '../src/config/env';
import { verifyMailConnection } from '../src/core/mail';

verifyMailConnection()
    .then((msg) => process.stdout.write(`OK: ${msg}\n`))
    .catch((err) => {
        process.stdout.write(`FAILED: ${(err as Error).message}\n`);
        process.exitCode = 1;
    });
