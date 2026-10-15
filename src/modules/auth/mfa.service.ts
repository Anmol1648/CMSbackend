import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

/**
 * Authenticator-app codes (TOTP: 6 digits, 30-second steps, SHA-1, Base32 secret).
 * otplib 12 (CommonJS) — v13 depends on ESM-only packages and breaks the compiled server.
 */
authenticator.options = { window: 1 }; // accept ±1 step (30 s) of clock drift

/** A new secret plus the QR code the user scans. `issuer` is what the app shows (the school's name). */
export const generateMfaSetup = async (accountLabel: string, issuer: string) => {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(accountLabel, issuer, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);
    return { secret, qrCodeDataUrl, otpauth };
};

export const verifyMfaToken = (token: string, secret: string): boolean =>
    /^[0-9]{6}$/.test(token) && authenticator.check(token, secret);

/** Current code for a secret (tests only). */
export const currentMfaCode = (secret: string) => authenticator.generate(secret);
