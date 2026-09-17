import { AppError } from './errors.js';
import { header } from './request.js';
import { loadConfig } from './config.js';
import { withTransaction } from './db.js';
import { gatewayRpc, useSupabaseRpc } from './remote-persistence.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

export function resolveIdempotencyKey(req, canonical) {
  const key = String(header(req, 'idempotency-key') || canonical.request_id || '').trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AppError(
      422,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8-160 characters using letters, numbers, dot, underscore, colon, or dash'
    );
  }
  return key;
}

export async function reserveIdempotency(input, options = {}) {
  const config = options.config ?? loadConfig();
  if (useSupabaseRpc(config)) {
    return gatewayRpc(
      'reserve_idempotency',
      input.ownerId,
      {
        key: input.key,
        canonical_hash: input.canonicalHash,
        request_id: input.requestId,
        ttl_seconds: input.ttlSeconds ?? config.idempotencyTtlSeconds
      },
      options
    );
  }

  const transaction = options.withTransaction ?? withTransaction;
  const ttlSeconds = input.ttlSeconds ?? config.idempotencyTtlSeconds;

  return transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [input.key]);

    const existing = await client.query(
      `select key, owner_id, canonical_hash, status, response_status, response_body, expires_at
         from idempotency_keys
        where key = $1
        for update`,
      [input.key]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      if (row.owner_id !== input.ownerId || row.canonical_hash !== input.canonicalHash) {
        throw new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was used with different canonical content'
        );
      }

      if (row.status === 'completed') {
        return {
          status: 'cached',
          responseStatus: row.response_status,
          responseBody: row.response_body
        };
      }

      const expiresAt = new Date(row.expires_at).getTime();
      if (row.status === 'in_progress' && expiresAt > Date.now()) {
        throw new AppError(
          409,
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this idempotency key is still running'
        );
      }

      await client.query(
        `update idempotency_keys
            set status = 'in_progress',
                response_status = null,
                response_body = null,
                last_error = null,
                attempt_count = attempt_count + 1,
                expires_at = now() + ($2::int * interval '1 second'),
                updated_at = now()
          where key = $1`,
        [input.key, ttlSeconds]
      );

      return { status: 'reserved' };
    }

    await client.query(
      `insert into idempotency_keys
        (key, owner_id, canonical_hash, request_id, status, expires_at)
       values ($1, $2, $3, $4, 'in_progress', now() + ($5::int * interval '1 second'))`,
      [input.key, input.ownerId, input.canonicalHash, input.requestId, ttlSeconds]
    );

    return { status: 'reserved' };
  }, options);
}

export async function completeIdempotency(input, options = {}) {
  const config = options.config ?? loadConfig();
  if (useSupabaseRpc(config)) {
    return gatewayRpc(
      'complete_idempotency',
      input.ownerId ?? process.env.RAVEL_DEFAULT_OWNER_ID,
      {
        key: input.key,
        canonical_hash: input.canonicalHash,
        response_status: input.responseStatus,
        response_body: input.responseBody
      },
      options
    );
  }

  const dbQuery = options.query;
  const run = dbQuery
    ? (sql, values) => dbQuery(sql, values)
    : (sql, values) => withTransaction((client) => client.query(sql, values), options);

  return run(
    `update idempotency_keys
        set status = 'completed',
            response_status = $3,
            response_body = $4::jsonb,
            updated_at = now()
      where key = $1
        and canonical_hash = $2
        and status = 'in_progress'`,
    [input.key, input.canonicalHash, input.responseStatus, JSON.stringify(input.responseBody)]
  );
}

export async function failIdempotency(input, options = {}) {
  const config = options.config ?? loadConfig();
  if (useSupabaseRpc(config)) {
    return gatewayRpc(
      'fail_idempotency',
      input.ownerId ?? process.env.RAVEL_DEFAULT_OWNER_ID,
      {
        key: input.key,
        canonical_hash: input.canonicalHash,
        error: input.error
      },
      options
    );
  }

  const dbQuery = options.query;
  const run = dbQuery
    ? (sql, values) => dbQuery(sql, values)
    : (sql, values) => withTransaction((client) => client.query(sql, values), options);

  return run(
    `update idempotency_keys
        set status = 'failed',
            last_error = $3::jsonb,
            updated_at = now()
      where key = $1
        and canonical_hash = $2
        and status = 'in_progress'`,
    [input.key, input.canonicalHash, JSON.stringify(input.error)]
  );
}
