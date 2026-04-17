import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import * as QRCode from 'qrcode';

/**
 * Configured TOTP instance following Google Authenticator standards:
 * - 6 digits, 30 second period, SHA1, Base32 encoding
 */
const totp = new TOTP({
    crypto: new NobleCryptoPlugin(),
    base32: new ScureBase32Plugin(),
});

export const generateMfaSetup = async (email: string) => {
    const secret = totp.generateSecret();
    const serviceName = 'Academic Architect';

    // toURI generates the otpauth:// URI for QR codes
    const otpauth = totp.toURI({
        secret,
        label: email,
        issuer: serviceName,
    });

    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    return {
        secret,
        qrCodeDataUrl,
        otpauth
    };
};

export const verifyMfaToken = async (token: string, secret: string): Promise<boolean> => {
    try {
        // epochTolerance: 30 allows ±30 seconds of clock drift (±1 step)
        const result = await totp.verify(token, {
            secret,
            epochTolerance: 30,
        });
        return result.valid;
    } catch (error) {
        console.error('[MFA] Verification error:', error);
        return false;
    }
};
