import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';

export class AuthService {
  // Login de usuário comum
  async loginUser(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { custom_rates: true },
    });

    if (!user) {
      throw { statusCode: 401, message: 'Email ou senha inválidos' };
    }

    // Verificar se tem hash de senha (usuários migrados do Supabase podem ter 'supabase_auth')
    if (user.password_hash === 'supabase_auth' || !user.password_hash) {
      throw { statusCode: 401, message: 'Por favor, redefina sua senha' };
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      throw { statusCode: 401, message: 'Email ou senha inválidos' };
    }

    // Retorna dados do usuário (sem a senha)
    const { password_hash, ...userData } = user;
    return userData;
  }

  // Login de admin
  async loginAdmin(email: string, password: string) {
    const admin = await prisma.adminCredential.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!admin || !admin.is_active) {
      throw { statusCode: 401, message: 'Credenciais inválidas' };
    }

    // Verificar senha (pode ser plain text para admins antigos ou bcrypt)
    let validPassword = false;
    
    if (admin.password_hash.startsWith('$2')) {
      // É bcrypt
      validPassword = await bcrypt.compare(password, admin.password_hash);
    } else {
      // Plain text (admins antigos) - comparar direto
      validPassword = admin.password_hash === password;
    }

    if (!validPassword) {
      throw { statusCode: 401, message: 'Credenciais inválidas' };
    }

    // Atualizar last_login
    await prisma.adminCredential.update({
      where: { id: admin.id },
      data: { last_login: new Date() },
    });

    const { password_hash, ...adminData } = admin;
    return adminData;
  }

  // Registrar novo usuário
  async registerUser(data: {
    name: string;
    email: string;
    password: string;
    cpf_cnpj?: string;
    phone?: string;
  }) {
    // Verificar se email já existe
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
    });

    if (existingUser) {
      throw { statusCode: 400, message: 'Este email já está cadastrado' };
    }

    // Hash da senha
    const password_hash = await bcrypt.hash(data.password, 10);

    // Criar usuário
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email.toLowerCase(),
        password_hash,
        cpf_cnpj: data.cpf_cnpj,
        phone: data.phone,
        account_status: 'pending',
      },
    });

    const { password_hash: _, ...userData } = user;
    return userData;
  }

  // Buscar usuário por ID
  async getUserById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      include: { custom_rates: true },
    });

    if (!user) {
      throw { statusCode: 404, message: 'Usuário não encontrado' };
    }

    const { password_hash, ...userData } = user;
    return userData;
  }

  // Buscar admin por ID
  async getAdminById(id: string) {
    const admin = await prisma.adminCredential.findUnique({
      where: { id },
    });

    if (!admin) {
      throw { statusCode: 404, message: 'Admin não encontrado' };
    }

    const { password_hash, ...adminData } = admin;
    return adminData;
  }

  // Atualizar senha do usuário
  async updatePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw { statusCode: 404, message: 'Usuário não encontrado' };
    }

    // Se o usuário tem 'supabase_auth', permite trocar sem verificar senha atual
    if (user.password_hash !== 'supabase_auth') {
      const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
      if (!validPassword) {
        throw { statusCode: 401, message: 'Senha atual incorreta' };
      }
    }

    const password_hash = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: { password_hash },
    });

    return { success: true };
  }
}

export const authService = new AuthService();
