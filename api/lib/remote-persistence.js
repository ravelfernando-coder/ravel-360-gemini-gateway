import { AppError, DependencyUnavailableError } from './errors.js';
import { loadConfig } from './config.js';

function statusForCode(code) {
  if (code === 'GATEWAY_UNAUTHORIZED' || code === 'GATEWAY_SECRET_REQUIRED') {
    return 401;
  }
  if (code === 'OWNER_NOT_FOUND' || code === 'OWNER_NOT_ACTIVE') {
    return 403;
  }
  if (['REQUEST_ID_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS'].includes(code)) {
    return 409;
  }
  return 500;
}

export function useSupabaseRpc(config = loadConfig()) {
  return config.persistenceBackend === 'supabase_rpc';
}

function rpcUrl(config) {
  return config.supabaseRuntimeFunctionUrl;
}

export async function gatewayRpc(operation, ownerId, payload = {}, options = {}) {
  const config = options.config ?? loadConfig();
  if (!useSupabaseRpc(config)) {
    throw new DependencyUnavailableError(
      'SUPABASE_RPC_NOT_ENABLED',
      'Supabase RPC persistence backend is not enabled'
    );
  }
  if (!config.supabaseUrl || !config.supabasePublishableKey || !config.ravelGatewaySecret) {
    throw new DependencyUnavailableError(
      'SUPABASE_RPC_CONFIG_INCOMPLETE',
      'Supabase RPC configuration is incomplete'
    );
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(rpcUrl(config), {
      method: 'POST',
      headers: {
        apikey: config.supabasePublishableKey,
        Authorization: 'Bearer ' + config.supabasePublishableKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        p_gateway_secret: config.ravelGatewaySecret,
        p_owner_id: ownerId,
        p_operation: operation,
        p_payload: payload
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}

    if (!response.ok) {
      throw new DependencyUnavailableError(
        'SUPABASE_RPC_HTTP_ERROR',
        'Supabase RPC returned HTTP ' + response.status,
        { statusCode: response.status }
      );
    }

    if (!data || data.ok === false) {
      const code = data?.code ?? 'SUPABASE_RPC_OPERATION_FAILED';
      throw new AppError(statusForCode(code), code, code);
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new DependencyUnavailableError(
        'SUPABASE_RPC_TIMEOUT',
        'Supabase RPC timed out after ' + timeoutMs + 'ms'
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
