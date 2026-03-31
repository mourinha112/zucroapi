import { config } from 'dotenv';

config();

export const env = {
  // Server
  PORT: parseInt(process.env.PORT || '3000'),
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',
  
  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  
  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // EfiBank
  EFI_CLIENT_ID: process.env.EFI_CLIENT_ID || '',
  EFI_CLIENT_SECRET: process.env.EFI_CLIENT_SECRET || '',
  EFI_PIX_KEY: process.env.EFI_PIX_KEY || '',
  EFI_CERTIFICATE_BASE64: process.env.EFI_CERTIFICATE_BASE64 || '',
  EFI_SANDBOX: process.env.EFI_SANDBOX === 'true',
  
  // Asaas
  ASAAS_API_KEY: process.env.ASAAS_API_KEY || '',
  ASAAS_SANDBOX: process.env.ASAAS_SANDBOX === 'true',

  // SharkBanking
  SHARK_PUBLIC_KEY: process.env.SHARK_PUBLIC_KEY || '',
  SHARK_SECRET_KEY: process.env.SHARK_SECRET_KEY || '',
  SHARK_WITHDRAW_KEY: process.env.SHARK_WITHDRAW_KEY || '',
  SHARK_WEBHOOK_URL: process.env.SHARK_WEBHOOK_URL || '',

  // Enki Bank
  ENKI_PUBLIC_KEY: process.env.ENKI_PUBLIC_KEY || '',
  ENKI_SECRET_KEY: process.env.ENKI_SECRET_KEY || '',
  ENKI_WITHDRAW_KEY: process.env.ENKI_WITHDRAW_KEY || '',
  ENKI_WEBHOOK_URL: process.env.ENKI_WEBHOOK_URL || '',

  // EuSouZucroPay
  EUSOUZUCROPAY_PUBLIC_KEY: process.env.EUSOUZUCROPAY_PUBLIC_KEY || '',
  EUSOUZUCROPAY_SECRET_KEY: process.env.EUSOUZUCROPAY_SECRET_KEY || '',
  EUSOUZUCROPAY_WITHDRAW_KEY: process.env.EUSOUZUCROPAY_WITHDRAW_KEY || '',
  EUSOUZUCROPAY_WEBHOOK_URL: process.env.EUSOUZUCROPAY_WEBHOOK_URL || '',
  
  // Resend (Email)
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',

  // Push Notifications
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_EMAIL: process.env.VAPID_EMAIL || '',
  
  // CORS
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
};

// Validar variáveis obrigatórias em produção
if (env.NODE_ENV === 'production') {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'SHARK_PUBLIC_KEY', 'SHARK_SECRET_KEY'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Variável de ambiente ${key} é obrigatória em produção`);
    }
  }
}
