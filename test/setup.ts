/**
 * Runs before every test file: points the app at the test database (cms_test) and refuses to run
 * against anything else, so tests can never touch real data.
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const testUrl = process.env.TEST_DATABASE_URL;
const testDirect = process.env.TEST_DIRECT_URL;
if (!testUrl || !testDirect) {
    throw new Error('TEST_DATABASE_URL and TEST_DIRECT_URL must be set in .env (a separate test database).');
}
for (const url of [testUrl, testDirect]) {
    if (new URL(url).pathname !== '/cms_test') throw new Error('Test database URLs must point at the cms_test database.');
}

process.env.DATABASE_URL = testUrl;
process.env.DIRECT_URL = testDirect;
process.env.DEFAULT_TENANT_CODE = '';
process.env.NODE_ENV = 'test';
