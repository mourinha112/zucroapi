// ============================================
// Middlewares - Export Central
// ============================================

// Autenticação JWT
export {
  authenticate,
  authenticateAdmin,
  optionalAuth,
  requireActiveUser,
} from './auth';

// Rate Limiting
export {
  createRateLimiter,
  standardRateLimit,
  authRateLimit,
  checkoutRateLimit,
  webhookRateLimit,
  createResourceRateLimit,
  integratorRateLimit,
  sensitiveActionRateLimit,
  userRateLimit,
} from './rate-limit';

// API Key (Integradores)
export {
  authenticateApiKey,
  authenticateApiKeyOrJwt,
  logApiKeyUsage,
  checkApiKeyPermission,
} from './api-key';
