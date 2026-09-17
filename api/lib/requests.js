import { AppError } from './errors.js';
import { query } from './db.js';
import { gatewayRpc, useSupabaseRpc } from './remote-persistence.js';

export async function createOrConfirmRequest(canonical, canonicalHash, options = {}) {
  if (useSupabaseRpc(options.config)) {
    return gatewayRpc(
      'create_request',
      canonical.owner_id,
      {
        request_id: canonical.request_id,
        canonical_hash: canonicalHash,
        operation: canonical.operation,
        payload: canonical.payload
      },
      options
    );
  }

  const dbQuery = options.query ?? query;
  await dbQuery(
    `insert into gateway_requests
      (request_id, owner_id, canonical_hash, operation, state, payload)
     values ($1, $2, $3, $4, 'received', $5::jsonb)
     on conflict (request_id) do nothing`,
    [
      canonical.request_id,
      canonical.owner_id,
      canonicalHash,
      canonical.operation,
      JSON.stringify(canonical.payload)
    ]
  );

  const result = await dbQuery(
    `select request_id, owner_id, canonical_hash, state
       from gateway_requests
      where request_id = $1`,
    [canonical.request_id]
  );

  const row = result.rows[0];
  if (!row || row.canonical_hash !== canonicalHash || row.owner_id !== canonical.owner_id) {
    throw new AppError(
      409,
      'REQUEST_ID_CONFLICT',
      'request_id already exists with different canonical content'
    );
  }

  return row;
}

export async function updateRequestState(requestId, state, data = {}, options = {}) {
  if (useSupabaseRpc(options.config)) {
    return gatewayRpc(
      'update_request_state',
      options.ownerId ?? process.env.RAVEL_DEFAULT_OWNER_ID,
      {
        request_id: requestId,
        state,
        ...(data.response === undefined ? {} : { response: data.response }),
        ...(data.error === undefined ? {} : { error: data.error })
      },
      options
    );
  }

  const dbQuery = options.query ?? query;
  return dbQuery(
    `update gateway_requests
        set state = $2,
            response = coalesce($3::jsonb, response),
            error = coalesce($4::jsonb, error),
            completed_at = case when $2 in ('succeeded', 'failed') then now() else completed_at end,
            updated_at = now()
      where request_id = $1`,
    [
      requestId,
      state,
      data.response === undefined ? null : JSON.stringify(data.response),
      data.error === undefined ? null : JSON.stringify(data.error)
    ]
  );
}

export async function recordProviderCall(call, options = {}) {
  if (useSupabaseRpc(options.config)) {
    return gatewayRpc(
      'record_provider_call',
      options.ownerId ?? process.env.RAVEL_DEFAULT_OWNER_ID,
      {
        request_id: call.requestId,
        provider: call.provider,
        model: call.model,
        status: call.status,
        http_status: call.httpStatus ?? null,
        attempt_count: call.attemptCount ?? null,
        latency_ms: call.latencyMs ?? null,
        error: call.error ?? null
      },
      options
    );
  }

  const dbQuery = options.query ?? query;
  return dbQuery(
    `insert into provider_calls
      (request_id, provider, model, status, http_status, attempt_count, latency_ms, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      call.requestId,
      call.provider,
      call.model,
      call.status,
      call.httpStatus ?? null,
      call.attemptCount ?? null,
      call.latencyMs ?? null,
      call.error ? JSON.stringify(call.error) : null
    ]
  );
}
