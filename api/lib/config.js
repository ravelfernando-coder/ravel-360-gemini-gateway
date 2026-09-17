export const VERSION = '3.0.0';

export const REQUIRED_RUNTIME_ENV = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL_NAME',
  'RAVEL_GATEWAY_SECRET'
];

export const REQUIRED_RPC_RUNTIME_ENV = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'GEMINI_API_KEY',
  'GEMINI_MODEL_NAME',
  'RAVEL_GATEWAY_SECRET'
];

export const REQUIRED_DEPLOY_ENV = ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'];

const DEFAULTS = {
  GEMINI_API_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
  RAVEL_PERSISTENCE_BACKEND: 'postgresql',
  RAVEL_REQUEST_TIMEOUT_MS: '25000',
  RAVEL_PROVIDER_TIMEOUT_MS: '20000',
  RAVEL_PROVIDER_RETRY_ATTEMPTS: '3',
  RAVEL_CIRCUIT_FAILURE_THRESHOLD: '5',
  RAVEL_CIRCUIT_COOLDOWN_MS: '30000',
  RAVEL_IDEMPOTENCY_TTL_SECONDS: '86400',
  PORT: '3000'
};

function parseInteger(name, value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function clean(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

export function envValue(env, name) {
  return clean(env[name] ?? DEFAULTS[name]);
}

export function hasEnv(env, name) {
  return clean(env[name]).length > 0;
}

export function requiredRuntimeEnv(env = process.env) {
  const backend = envValue(env, 'RAVEL_PERSISTENCE_BACKEND') || 'postgresql';
  return backend === 'supabase_rpc' ? REQUIRED_RPC_RUNTIME_ENV : REQUIRED_RUNTIME_ENV;
}

export function missingEnv(env, names) {
  return names.filter((name) => !hasEnv(env, name));
}

export function loadConfig(env = process.env) {
  return {
    version: VERSION,
    nodeEnv: envValue(env, 'NODE_ENV') || 'development',
    port: parseInteger('PORT', envValue(env, 'PORT'), 1, 65535),
    persistenceBackend: envValue(env, 'RAVEL_PERSISTENCE_BACKEND') || 'postgresql',
    databaseUrl: envValue(env, 'DATABASE_URL'),
    supabaseUrl: envValue(env, 'SUPABASE_URL'),
    supabasePublishableKey: envValue(env, 'SUPABASE_PUBLISHABLE_KEY'),
    supabaseRuntimeFunctionUrl:
      envValue(env, 'SUPABASE_RUNTIME_FUNCTION_URL') ||
      `${envValue(env, 'SUPABASE_URL')}/functions/v1/ravel360-gateway-runtime-op`,
    geminiApiKey: envValue(env, 'GEMINI_API_KEY'),
    geminiModelName: envValue(env, 'GEMINI_MODEL_NAME'),
    geminiApiBaseUrl: envValue(env, 'GEMINI_API_BASE_URL'),
    ravelGatewaySecret: envValue(env, 'RAVEL_GATEWAY_SECRET'),
    ravelDefaultOwnerId: envValue(env, 'RAVEL_DEFAULT_OWNER_ID'),
    requestTimeoutMs: parseInteger(
      'RAVEL_REQUEST_TIMEOUT_MS',
      envValue(env, 'RAVEL_REQUEST_TIMEOUT_MS'),
      1000,
      120000
    ),
    providerTimeoutMs: parseInteger(
      'RAVEL_PROVIDER_TIMEOUT_MS',
      envValue(env, 'RAVEL_PROVIDER_TIMEOUT_MS'),
      1000,
      120000
    ),
    providerRetryAttempts: parseInteger(
      'RAVEL_PROVIDER_RETRY_ATTEMPTS',
      envValue(env, 'RAVEL_PROVIDER_RETRY_ATTEMPTS'),
      1,
      6
    ),
    circuitFailureThreshold: parseInteger(
      'RAVEL_CIRCUIT_FAILURE_THRESHOLD',
      envValue(env, 'RAVEL_CIRCUIT_FAILURE_THRESHOLD'),
      1,
      50
    ),
    circuitCooldownMs: parseInteger(
      'RAVEL_CIRCUIT_COOLDOWN_MS',
      envValue(env, 'RAVEL_CIRCUIT_COOLDOWN_MS'),
      1000,
      600000
    ),
    idempotencyTtlSeconds: parseInteger(
      'RAVEL_IDEMPOTENCY_TTL_SECONDS',
      envValue(env, 'RAVEL_IDEMPOTENCY_TTL_SECONDS'),
      60,
      604800
    )
  };
}

export function runtimeConfigStatus(env = process.env) {
  const status = requiredRuntimeEnv(env);
  const backend = envValue(env, 'RAVEL_PERSISTENCE_BACKEND') || 'postgresql';
  const databaseReady =
    backend === 'supabase_rpc'
      ? hasEnv(env, 'SUPABASE_URL') && hasEnv(env, 'SUPABASE_PUBLISHABLE_KEY')
      : hasEnv(env, 'DATABASE_URL');

  return {
    version: VERSION,
    persistenceBackend: backend,
    requiredRuntime: status,
    missingRuntime: missingEnv(env, status),
    missingDeploy: missingEnv(env, REQUIRED_DEPLOY_ENV),
    configured: {
      database: databaseReady,
      supabaseUrl: hasEnv(env, 'SUPABASE_URL'),
      supabasePublishableKey: hasEnv(env, 'SUPABASE_PUBLISHABLE_KEY'),
      geminiApiKey: hasEnv(env, 'GEMINI_API_KEY'),
      geminiModelName: hasEnv(env, 'GEMINI_MODEL_NAME'),
      gatewaySecret: hasEnv(env, 'RAVEL_GATEWAY_SECRET'),
      vercelToken: hasEnv(env, 'VERCEL_TOKEN'),
      vercelOrgId: hasEnv(env, 'VERCEL_ORG_ID'),
      vercelProjectId: hasEnv(env, 'VERCEL_PROJECT_ID')
    }
  };
}
