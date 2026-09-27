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

const FRONT_URL = (process.env.FRONTEND_URL && /^https:\/\//.test(process.env.FRONTEND_URL)) ? process.env.FRONTEND_URL.replace(/\/$/, '') : 'https://dashboard.appzucropay.com';

function shell(title: string, body: string) {
  return `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 0;">
      <div style="background: linear-gradient(135deg, #5818C8 0%, #380F7F 100%); padding: 40px 32px; text-align: center; border-radius: 16px 16px 0 0;">
        <img src="https://dashboard.appzucropay.com/logotipo.webp" alt="ZucroPay" style="height: 40px; margin-bottom: 16px;" />
        <h1 style="color: #ffffff; font-size: 22px; font-weight: 700; margin: 0;">${title}</h1>
      </div>
      <div style="background: #ffffff; padding: 40px 32px; border: 1px solid #e5e7eb; border-top: none;">${body}</div>
      <div style="padding: 20px 32px; text-align: center; border-radius: 0 0 16px 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
        <p style="color: #9ca3af; font-size: 11px; margin: 0;">&copy; 2026 ZucroPay. Todos os direitos reservados.</p>
      </div>
    </div>`;
}

export async function sendPasswordResetEmail(email: string, userName: string, token: string): Promise<boolean> {
  const link = `${FRONT_URL}/recover-password/${token}?email=${encodeURIComponent(email)}`;
  try {
    const { error } = await resend.emails.send({
      from: 'ZucroPay <noreply@appzucropay.com>',
      to: email,
      subject: 'Redefinir sua senha ZucroPay',
      html: shell('Redefinir senha', `
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;">Olá <strong>${userName}</strong>, recebemos um pedido para redefinir a sua senha. O link abaixo vale por <strong>1 hora</strong>.</p>
        <p style="text-align:center;margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#5818C8;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:12px;">Criar nova senha</a></p>
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:0;">Se você não pediu isso, ignore este e-mail. Sua senha continua a mesma.</p>`),
    });
    if (error) { console.error('[Email] Erro ao enviar reset:', error); return false; }
    return true;
  } catch (err: any) { console.error('[Email] Erro:', err.message); return false; }
}

export async function sendCollaboratorInvite(email: string, ownerName: string, token: string): Promise<boolean> {
  const link = `${FRONT_URL}/signup?invite=${token}`;
  try {
    const { error } = await resend.emails.send({
      from: 'ZucroPay <noreply@appzucropay.com>',
      to: email,
      subject: `${ownerName} convidou você para a ZucroPay`,
      html: shell('Convite de colaborador', `
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;"><strong>${ownerName}</strong> convidou você para colaborar na conta ZucroPay dele(a).</p>
        <p style="text-align:center;margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#5818C8;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:12px;">Aceitar convite</a></p>
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:0;">Se você não conhece esta pessoa, ignore este e-mail.</p>`),
    });
    if (error) { console.error('[Email] Erro ao enviar convite:', error); return false; }
    return true;
  } catch (err: any) { console.error('[Email] Erro:', err.message); return false; }
}

export async function sendAccountApprovedEmail(email: string, userName: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({
      from: 'ZucroPay <noreply@appzucropay.com>',
      to: email,
      subject: 'Sua conta ZucroPay foi aprovada! 🎉',
      html: `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 0;">
          <div style="background: linear-gradient(135deg, #5818C8 0%, #380F7F 100%); padding: 40px 32px; text-align: center; border-radius: 16px 16px 0 0;">
            <img src="https://dashboard.appzucropay.com/logotipo.webp" alt="ZucroPay" style="height: 40px; margin-bottom: 16px;" />
            <h1 style="color: #ffffff; font-size: 22px; font-weight: 700; margin: 0;">Conta Aprovada</h1>
          </div>
          <div style="background: #ffffff; padding: 40px 32px; border: 1px solid #e5e7eb; border-top: none;">
            <p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
              Olá <strong>${userName}</strong>,
            </p>
            <p style="color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
              Boas notícias! Sua conta na <strong>ZucroPay</strong> foi <strong style="color: #16a34a;">aprovada</strong> e já está liberada para uso. Agora você pode acessar todos os recursos da plataforma, criar produtos, receber pagamentos e solicitar saques.
            </p>
            <div style="background: #f0fdf4; border: 2px solid #22c55e; border-radius: 12px; padding: 20px; text-align: center; margin: 0 0 24px;">
              <span style="font-size: 18px; font-weight: 700; color: #16a34a;">
                ✓ Conta verificada e liberada
              </span>
            </div>
            <div style="text-align: center; margin: 0 0 24px;">
              <a href="https://dashboard.appzucropay.com/login" style="display: inline-block; background: linear-gradient(135deg, #5818C8 0%, #380F7F 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 600; font-size: 15px;">
                Acessar minha conta
              </a>
            </div>
            <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0;">
              Se tiver qualquer dúvida, basta responder este email — nossa equipe está pronta para te ajudar.
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
      console.error('[Email] Erro ao enviar aprovação:', error);
      return false;
    }

    console.log(`[Email] Aprovação enviada para ${email}`);
    return true;
  } catch (err: any) {
    console.error('[Email] Erro:', err.message);
    return false;
  }
}
