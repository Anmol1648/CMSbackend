/**
 * Runs the report service (jasper-service, JasperReports) on this computer for the backend to use.
 *   npm run jasper            builds it first if needed (Docker, or Maven when installed), then starts it
 *   npm run jasper -- --build  builds it again
 * Needs Java 17+. It listens on the port of JASPER_URL (default 8090) and uses JASPER_TOKEN from .env.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawnSync, spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const dir = path.join(__dirname, '..', 'jasper-service');
const jar = path.join(dir, 'target', 'jasper-service.jar');

const build = () => {
  const mvn = spawnSync(process.platform === 'win32' ? 'mvn.cmd' : 'mvn', ['-q', '-B', 'package', '-DskipTests'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (mvn.status === 0) return;
  console.log('Maven not available: building with Docker (maven:3.9-eclipse-temurin-17)…');
  const docker = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/src`, '-v', 'jasper-m2:/root/.m2', '-w', '/src', 'maven:3.9-eclipse-temurin-17', 'mvn', '-q', '-B', 'package', '-DskipTests'], { stdio: 'inherit' });
  if (docker.status !== 0) {
    console.error('Could not build the report service: install Maven or Docker.');
    process.exit(1);
  }
};

if (process.argv.includes('--build') || !fs.existsSync(jar)) build();

const url = new URL(process.env.JASPER_URL || 'http://127.0.0.1:8090');
const port = url.port || '8090';

// Something already listening there: say what it is instead of a Java "Address already in use".
const free = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(Number(port), '127.0.0.1');
  });

const start = async () => {
  if (!(await free())) {
    const running = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .catch(() => null);
    if (running?.jasperreports) console.log(`The report service is already running on port ${port} (JasperReports ${running.jasperreports}). Nothing to do.`);
    else console.error(`Port ${port} is used by another program. Stop it, or set JASPER_URL in .env to another port (e.g. http://127.0.0.1:8091).`);
    process.exit(running?.jasperreports ? 0 : 1);
  }
  run();
};

const run = () => {
  const child = spawn('java', ['-Djava.awt.headless=true', '-cp', [jar, path.join(dir, 'target', 'lib', '*')].join(path.delimiter), 'school.reports.Main'], {
    stdio: 'inherit',
    env: { ...process.env, HOST: process.env.JASPER_HOST || '127.0.0.1', PORT: port },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
};

start();
