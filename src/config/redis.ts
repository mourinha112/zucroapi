import { env } from './env';

// ============================================
// REDIS COMPLETAMENTE DESABILITADO EM DEV
// Para usar Redis, rode: docker run -d -p 6379:6379 redis:alpine
// ============================================

// Flag para controlar se Redis está disponível
let redisEnabled = false;

// Só tenta conectar se REDIS_URL não for localhost (ou se Redis estiver rodando)
// Por padrão, desabilitamos para desenvolvimento sem Redis
console.log('[Redis] ⚠️ Desabilitado - cache e filas não funcionarão');
console.log('[Redis] Para habilitar: docker run -d -p 6379:6379 redis:alpine');

// Mock do Redis para não quebrar imports
export const redis = null;

// Funções de cache (sempre retornam fallback sem Redis)
export const cache = {
  async get<T>(_key: string): Promise<T | null> {
    return null;
  },

  async set(_key: string, _value: any, _ttlSeconds: number = 3600): Promise<void> {
    // No-op
  },

  async del(_key: string): Promise<void> {
    // No-op
  },

  async exists(_key: string): Promise<boolean> {
    return false;
  },
};

// Exporta flag para verificar status
export const isRedisConnected = () => redisEnabled;
