/**
 * Writes the SQL needed to bring the TEST database (cms_test, already migrated) to the current
 * schema.prisma, into prisma/migrations/<name>/migration.sql. Review it, then apply with
 * `npm run db:migrate` (main) and the same against the test database.
 *   node scripts/migration-diff.js 20261015190000_login_page_branding
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const name = process.argv[2];
if (!name || !/^\d{14}_[a-z0-9_]+$/.test(name)) throw new Error('Give a migration name like 20261015190000_what_changed');
const dir = path.join(__dirname, '..', 'prisma', 'migrations', name);
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'migration.sql');
const cli = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');
const r = spawnSync(process.execPath, [cli, 'migrate', 'diff', '--from-url', process.env.TEST_DIRECT_URL, '--to-schema-datamodel', 'prisma/schema.prisma', '--script', '-o', out], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
if (r.status !== 0) process.exit(r.status ?? 1);
process.stdout.write(fs.readFileSync(out, 'utf8'));
