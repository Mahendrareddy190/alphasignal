import nodemailer from 'nodemailer';
import dns from 'dns';
import 'dotenv/config';

const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  // Force IPv4 DNS lookup — Render free tier has no IPv6 egress
  lookup: (hostname: string, options: any, callback: any) =>
    dns.lookup(hostname, { ...options, family: 4 }, callback),
  connectionTimeout: 10000,
  greetingTimeout:   10000,
  socketTimeout:     15000,
} as any);

export async function sendOtpEmail(toEmail: string, otp: string, username: string): Promise<void> {
  const expiry = parseInt(process.env.OTP_EXPIRY_MINUTES || '10');
  await transporter.sendMail({
    from: `"AlphaSignal Trading" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: `${otp} — Your AlphaSignal verification code`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',system-ui,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden">
        <tr><td style="background:#f0b90b;padding:20px 32px">
          <span style="font-size:1.3rem;font-weight:800;color:#000">⚡ AlphaSignal</span>
        </td></tr>
        <tr><td style="padding:32px">
          <h2 style="color:#e6edf3;margin:0 0 8px">Verify your email</h2>
          <p style="color:#8b949e;margin:0 0 28px">Hi <strong style="color:#e6edf3">${username}</strong>, use the code below to complete your registration.</p>
          <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:24px;text-align:center;margin-bottom:28px">
            <span style="font-size:2.2rem;font-weight:800;letter-spacing:10px;color:#f0b90b">${otp}</span>
          </div>
          <p style="color:#8b949e;font-size:.85rem;margin:0">This code expires in <strong style="color:#e6edf3">${expiry} minutes</strong>. If you didn't request this, ignore this email.</p>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #30363d">
          <p style="color:#8b949e;font-size:.75rem;margin:0">AlphaSignal Demo Trading Platform</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

export async function verifyMailerConfig(): Promise<boolean> {
  try {
    await transporter.verify();
    return true;
  } catch {
    return false;
  }
}
