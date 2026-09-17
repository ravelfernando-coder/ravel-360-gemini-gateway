import pg from 'pg';
import { loadConfig } from './config.js';
import { DependencyUnavailableError } from './errors.js';
import { gatewayRpc, useSupabaseRpc } from './remote-persistence.js';

const { Pool } = pg;
let pool;

function useSsl(connectionString) {
  if (!connectionString) {
    return false;
  }
  const lower = connectionString.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

function timeoutPromise(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(
        new DependencyUnavailableError('DATABASE_TIMEOUT', `${label} timed out after ${ms}ms`)
      );
    }, ms);
  });
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutPromise(ms, label)]);
}

export function hasDatabaseConfig(config = loadConfig()) {
  if (useSupabaseRpc(config)) {
    return Boolean(
      config.supabaseUrl && config.supabasePublishableKey && config.ravelGatewaySecret
    );
  }
  return Boolean(config.databaseUrl);
}

export function createPool(config = loadConfig()) {
  if (!config.databaseUrl) {
    throw new DependencyUnavailableError('DATABASE_NOT_CONFIGURED', 'DATABASE_URL is required');
  }

  return new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Math.min(config.requestTimeoutMs, 10000),
    ssl: useSsl(config.databaseUrl)
  });
}

export function getPool(config = loadConfig()) {
  if (!pool) {
    pool = createPool(config);
  }
  return pool;
}

export async function query(text, values = [], options = {}) {
  const config = options.config ?? loadConfig();
  const activePool = options.pool ?? getPool(config);
  return withTimeout(
    activePool.query(text, values),
    options.timeoutMs ?? config.requestTimeoutMs,
    'database query'
  );
}

export async function withTransaction(callback, options = {}) {
  const config = options.config ?? loadConfig();
  const activePool = options.pool ?? getPool(config);
  const client = await withTimeout(
    activePool.connect(),
    options.timeoutMs ?? config.requestTimeoutMs,
    'database connection'
  );

  const tx = {
    query(sql, values = []) {
      return withTimeout(
        client.query(sql, values),
        options.timeoutMs ?? config.requestTimeoutMs,
        'database query'
      );
    }
  };

  try {
    await tx.query('BEGIN');
    const result = await callback(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await tx.query('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function assertDatabaseReady(options = {}) {
  const config = options.config ?? loadConfig();
  if (useSupabaseRpc(config)) {
    const ownerId = options.ownerId ?? config.ravelDefaultOwnerId;
    if (!ownerId) {
      throw new DependencyUnavailableError(
        'RAVEL_DEFAULT_OWNER_ID_NOT_CONFIGURED',
        'RAVEL_DEFAULT_OWNER_ID is required for Supabase RPC readiness'
      );
    }
    const result = await gatewayRpc('health', ownerId, {}, options);
    return {
      database_name: result.database_name,
      checked_at: result.checked_at,
      latest_schema_migration: result.latest_schema_migration
    };
  }

  const result = await query(
    'select current_database() as database_name, now() as checked_at',
    [],
    options
  );
  return result.rows[0];
}

export async function closePool() {
  if (pool) {
    const active = pool;
    pool = undefined;
    await active.end();
  }
}
