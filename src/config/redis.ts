import Redis from 'ioredis';
import { env } from './env';

// ============================================
// REDIS - Conecta em produção, mock em dev
// ============================================

let redisInstance: Redis | null = null;
let redisEnabled = false;

// Tenta conectar ao Redis
if (env.NODE_ENV === 'production' || env.REDIS_URL !== 'redis://localhost:6379') {
  try {
    redisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          console.log('[Redis] ❌ Falha ao conectar após 3 tentativas');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redisInstance.on('connect', () => {
      console.log('[Redis] ✅ Conectado');
      redisEnabled = true;
    });

    redisInstance.on('error', (err) => {
      console.log('[Redis] ⚠️ Erro:', err.message);
      redisEnabled = false;
    });

    // Tenta conectar
    redisInstance.connect().catch(() => {
      console.log('[Redis] ⚠️ Não foi possível conectar - continuando sem cache');
      redisInstance = null;
    });
  } catch (error) {
    console.log('[Redis] ⚠️ Erro ao inicializar - continuando sem cache');
    redisInstance = null;
  }
} else {
  console.log('[Redis] ⚠️ Desabilitado em dev - cache não funcionará');
}

// Exporta a instância (pode ser null)
export const redis = redisInstance;

// Funções de cache (com fallback se Redis não disponível)
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    if (!redis || !redisEnabled) return null;
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  async set(key: string, value: any, ttlSeconds: number = 3600): Promise<void> {
    if (!redis || !redisEnabled) return;
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Ignora erro
    }
  },

  async del(key: string): Promise<void> {
    if (!redis || !redisEnabled) return;
    try {
      await redis.del(key);
    } catch {
      // Ignora erro
    }
  },

  async exists(key: string): Promise<boolean> {
    if (!redis || !redisEnabled) return false;
    try {
      return (await redis.exists(key)) === 1;
    } catch {
      return false;
    }
  },
};

// Exporta flag para verificar status
export const isRedisConnected = () => redisEnabled;
