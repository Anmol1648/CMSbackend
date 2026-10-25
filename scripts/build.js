/**
 * Production build: turns src/**\/*.ts into dist/**\/*.js with esbuild (file by file, no bundling).
 *
 * `tsc` also type-checks, and with the large Prisma client that needs more than 2 GB of memory —
 * more than the Render build machine has. Types are checked before every commit (`npm run typecheck`),
 * so the build only has to translate. Usage: node scripts/build.js [outDir]
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const out = path.join(root, process.argv[2] || 'dist');

const files = [];
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p);
    }
};
walk(src);

fs.rmSync(out, { recursive: true, force: true });
esbuild
    // dynamic-import off: `await import('./x')` becomes require('./x') (as tsc makes it). Left as a real
    // import(), Node resolves it as ESM, which needs the ".js" extension, and the lazy imports fail.
    .build({ entryPoints: files, outdir: out, outbase: src, bundle: false, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'warning', supported: { 'dynamic-import': false } })
    .then(() => process.stdout.write(`Built ${files.length} files into ${path.relative(root, out)}\n`))
    .catch(() => process.exit(1));
