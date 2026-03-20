import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || '');

export async function sendLoginCode(email: string, code: string, userName: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({
      from: 'ZucroPay <noreply@appzucropay.com>',
      to: email,
      subject: `${code} - Código de verificação ZucroPay`,
      html: `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 0;">
          <div style="background: linear-gradient(135deg, #5818C8 0%, #380F7F 100%); padding: 40px 32px; text-align: center; border-radius: 16px 16px 0 0;">
            <img src="https://dashboard.appzucropay.com/logotipo.webp" alt="ZucroPay" style="height: 40px; margin-bottom: 16px;" />
            <h1 style="color: #ffffff; font-size: 22px; font-weight: 700; margin: 0;">Código de Verificação</h1>
          </div>
          <div style="background: #ffffff; padding: 40px 32px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
              Olá <strong>${userName}</strong>, use o código abaixo para acessar sua conta:
            </p>
            <div style="background: #f8f5ff; border: 2px solid #5818C8; border-radius: 12px; padding: 24px; text-align: center; margin: 0 0 24px;">
              <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #5818C8; font-family: monospace;">
                ${code}
              </span>
            </div>
            <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0 0 8px;">
              Este código expira em <strong>5 minutos</strong>.
            </p>
            <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; margin: 0;">
              Se você não solicitou este código, ignore este email.
            </p>
          </div>
          <div style="padding: 20px 32px; text-align: center; border-radius: 0 0 16px 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
            <img src="https://dashboard.appzucropay.com/logotipo.png" alt="ZucroPay" style="height: 28px; margin-bottom: 8px;" />
            <p style="color: #9ca3af; font-size: 11px; margin: 0;">
              &copy; 2026 ZucroPay. Todos os direitos reservados.
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('[Email] Erro ao enviar código:', error);
      return false;
    }

    console.log(`[Email] Código enviado para ${email}`);
    return true;
  } catch (err: any) {
    console.error('[Email] Erro:', err.message);
    return false;
  }
}
