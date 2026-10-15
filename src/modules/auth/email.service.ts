import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

export const sendPasswordResetEmail = async (email: string, otp: string) => {
  const mailOptions = {
    from: `"Academic Architect" <${process.env.SMTP_FROM}>`,
    to: email,
    subject: 'Password Reset OTP - Academic Architect',
    html: `
      <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; border: 1px solid #e2e8f0; border-radius: 24px; color: #1e293b; background: white;">
        <div style="text-align: center; margin-bottom: 32px;">
           <h1 style="font-size: 28px; font-weight: 800; color: #0f172a; margin: 0; letter-spacing: -0.02em;">Academic Architect</h1>
           <p style="font-size: 14px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 8px;">Security Service</p>
        </div>
        
        <div style="margin-bottom: 32px;">
          <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-bottom: 16px;">Reset your password</h2>
          <p style="font-size: 16px; line-height: 24px; color: #475569;">
            We received a request to reset your password. Use the verification code below to proceed. This code will expire in 15 minutes.
          </p>
        </div>

        <div style="background: #f8fafc; border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 32px; border: 1px solid #f1f5f9;">
          <span style="font-size: 40px; font-weight: 800; letter-spacing: 0.2em; color: #2563eb; font-family: monospace;">${otp}</span>
        </div>

        <p style="font-size: 14px; line-height: 20px; color: #64748b; text-align: center;">
          If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
        </p>

        <div style="border-top: 1px solid #f1f5f9; padding-top: 32px; margin-top: 32px; text-align: center;">
          <p style="font-size: 12px; color: #94a3b8;">
            &copy; 2026 Lizone Design - Academic Architect ERP<br />
            Powered by The Digital Atelier
          </p>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('[EmailService] Password reset email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('[EmailService] Error sending email:', error);
    throw new Error('Failed to send password reset email');
  }
};
