import 'dotenv/config';

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

export async function sendOtpEmail(toEmail: string, otp: string, username: string): Promise<void> {
  const expiry  = parseInt(process.env.OTP_EXPIRY_MINUTES || '10');
  const apiKey  = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_USER || 'mrmahicrypto@gmail.com';

  if (!apiKey) throw new Error('BREVO_API_KEY environment variable not set');

  const html = `
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
</html>`;

  const res = await fetch(BREVO_API, {
    method:  'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender:      { name: 'AlphaSignal Trading', email: fromEmail },
      to:          [{ email: toEmail }],
      subject:     `${otp} — Your AlphaSignal verification code`,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${err}`);
  }
}

export async function verifyMailerConfig(): Promise<boolean> {
  return !!process.env.BREVO_API_KEY;
}
