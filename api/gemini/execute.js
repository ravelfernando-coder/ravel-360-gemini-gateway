import { authenticateRequest } from '../lib/auth.js';
import { assertCanonicalHash, suppliedCanonicalHash } from '../lib/hasher.js';
import {
  AppError,
  assertMethod,
  sendJson,
  toErrorPayload,
  withErrorHandling
} from '../lib/errors.js';
import { readJsonBody } from '../lib/request.js';
import { assertOwnerHeaderMatchesCanonical, verifyOwnership } from '../lib/ownership.js';
import {
  resolveIdempotencyKey,
  reserveIdempotency,
  completeIdempotency,
  failIdempotency
} from '../lib/idempotency.js';
import { callGemini } from '../lib/provider.js';
import { recordAuditEvent } from '../lib/audit.js';
import { createOrConfirmRequest, updateRequestState, recordProviderCall } from '../lib/requests.js';

function publicError(error) {
  const payload = toErrorPayload(error);
  return {
    code: payload.error.code,
    message: payload.error.message
  };
}

export default async function handler(req, res) {
  return withErrorHandling(req, res, async () => {
    assertMethod(req, ['POST']);

    const body = await readJsonBody(req);
    const canonical = body.canonical;
    const canonicalHash = assertCanonicalHash(canonical, suppliedCanonicalHash(req, body));
    const authContext = authenticateRequest(req);
    assertOwnerHeaderMatchesCanonical(authContext, canonical.owner_id);
    await verifyOwnership(canonical.owner_id);

    const idempotencyKey = resolveIdempotencyKey(req, canonical);
    const requestRecord = await createOrConfirmRequest(canonical, canonicalHash);
    let requestState = requestRecord.state;
    if (requestState === 'received') {
      await updateRequestState(
        canonical.request_id,
        'validated',
        {},
        { ownerId: canonical.owner_id }
      );
      requestState = 'validated';
    }

    const reservation = await reserveIdempotency({
      key: idempotencyKey,
      ownerId: canonical.owner_id,
      canonicalHash,
      requestId: canonical.request_id
    });

    if (reservation.status === 'cached') {
      await recordAuditEvent({
        ownerId: canonical.owner_id,
        requestId: canonical.request_id,
        eventType: 'request.replayed',
        actorId: authContext.actorId,
        details: { idempotencyKey }
      });
      return sendJson(res, reservation.responseStatus ?? 200, reservation.responseBody, {
        'X-Ravel-Idempotency-Replayed': 'true'
      });
    }

    if (['validated', 'reserved'].includes(requestState)) {
      await updateRequestState(
        canonical.request_id,
        'reserved',
        {},
        { ownerId: canonical.owner_id }
      );
    } else {
      throw new AppError(
        409,
        'REQUEST_RETRY_REQUIRES_NEW_REQUEST_ID',
        'A terminal request cannot be retried with the same request_id'
      );
    }
    await recordAuditEvent({
      ownerId: canonical.owner_id,
      requestId: canonical.request_id,
      eventType: 'request.accepted',
      actorId: authContext.actorId,
      details: {
        idempotencyKey,
        canonicalHash,
        operation: canonical.operation
      }
    });

    try {
      await updateRequestState(
        canonical.request_id,
        'provider_call',
        {},
        { ownerId: canonical.owner_id }
      );
      const provider = await callGemini(canonical.payload);
      const responseBody = {
        version: '3.0.0',
        state: 'succeeded',
        request_id: canonical.request_id,
        owner_id: canonical.owner_id,
        canonical_hash: canonicalHash,
        provider: provider.provider,
        model: provider.model,
        provider_response: provider.body
      };

      await recordProviderCall(
        {
          requestId: canonical.request_id,
          provider: provider.provider,
          model: provider.model,
          status: 'succeeded',
          httpStatus: 200,
          attemptCount: provider.attempt,
          latencyMs: provider.latencyMs
        },
        { ownerId: canonical.owner_id }
      );
      await completeIdempotency({
        key: idempotencyKey,
        ownerId: canonical.owner_id,
        canonicalHash,
        responseStatus: 200,
        responseBody
      });
      await updateRequestState(
        canonical.request_id,
        'succeeded',
        { response: responseBody },
        { ownerId: canonical.owner_id }
      );
      await recordAuditEvent({
        ownerId: canonical.owner_id,
        requestId: canonical.request_id,
        eventType: 'request.succeeded',
        actorId: authContext.actorId,
        details: {
          provider: provider.provider,
          model: provider.model,
          latencyMs: provider.latencyMs
        }
      });

      return sendJson(res, 200, responseBody);
    } catch (error) {
      const errorBody = publicError(
        error instanceof Error ? error : new AppError(500, 'UNKNOWN_ERROR', 'Unknown error')
      );
      await failIdempotency({
        key: idempotencyKey,
        ownerId: canonical.owner_id,
        canonicalHash,
        error: errorBody
      });
      await updateRequestState(
        canonical.request_id,
        'failed',
        { error: errorBody },
        { ownerId: canonical.owner_id }
      );
      await recordProviderCall(
        {
          requestId: canonical.request_id,
          provider: 'gemini',
          model: process.env.GEMINI_MODEL_NAME ?? null,
          status: 'failed',
          httpStatus: error.statusCode ?? null,
          error: errorBody
        },
        { ownerId: canonical.owner_id }
      );
      await recordAuditEvent({
        ownerId: canonical.owner_id,
        requestId: canonical.request_id,
        eventType: 'request.failed',
        actorId: authContext.actorId,
        severity: 'error',
        details: errorBody
      });
      throw error;
    }
  });
}
