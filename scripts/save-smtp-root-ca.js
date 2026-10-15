/**
 * Saves the root certificate that the SMTP connection is signed by into certs/smtp-root-ca.pem.
 * Needed when antivirus software (e.g. AVG / Avast Mail Shield) re-signs mail traffic with its own
 * root: point SMTP_CA_FILE at the file so only that root is trusted (verification stays on).
 *   node scripts/save-smtp-root-ca.js
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT) || 587;
if (!host) throw new Error('SMTP_HOST is not set');

const toPem = (raw) => `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

const socket = net.connect(port, host);
let buf = '';
let step = 0;
socket.on('data', (d) => {
  buf += d.toString();
  if (step === 0 && /^220 /m.test(buf)) { step = 1; buf = ''; socket.write('EHLO cms\r\n'); }
  else if (step === 1 && /^250 /m.test(buf)) { step = 2; buf = ''; socket.write('STARTTLS\r\n'); }
  else if (step === 2 && /^220 /m.test(buf)) {
    step = 3;
    // Not verifying here on purpose: we only read the chain to save its root.
    const t = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
      let cert = t.getPeerCertificate(true);
      const seen = new Set();
      while (cert.issuerCertificate && cert.issuerCertificate !== cert && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        cert = cert.issuerCertificate;
      }
      const dir = path.join(__dirname, '..', 'certs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'smtp-root-ca.pem');
      fs.writeFileSync(file, toPem(cert.raw));
      console.log(`Saved root "${cert.subject?.CN}" (issuer ${cert.issuer?.O ?? cert.issuer?.CN}) to ${file}`);
      console.log('Set SMTP_CA_FILE=certs/smtp-root-ca.pem in .env');
      t.end();
      process.exit(0);
    });
  }
});
socket.on('error', (e) => { console.error('Could not connect:', e.message); process.exit(1); });
setTimeout(() => { console.error('Timed out talking to the SMTP server'); process.exit(1); }, 15000);
