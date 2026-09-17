import { AppError } from './errors.js';
import { query } from './db.js';
import { gatewayRpc, useSupabaseRpc } from './remote-persistence.js';

export function assertOwnerHeaderMatchesCanonical(authContext, canonicalOwnerId) {
  if (authContext.ownerId && authContext.ownerId !== canonicalOwnerId) {
    throw new AppError(403, 'OWNER_MISMATCH', 'Authenticated owner does not match canonical owner');
  }
}

export async function verifyOwnership(ownerId, options = {}) {
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw new AppError(422, 'INVALID_OWNER_ID', 'owner_id is required');
  }

  if (useSupabaseRpc(options.config)) {
    const result = await gatewayRpc('verify_owner', ownerId, {}, options);
    return { owner_id: result.owner_id, status: result.status };
  }

  const dbQuery = options.query ?? query;
  const result = await dbQuery(
    'select owner_id, status from gateway_owners where owner_id = $1 limit 1',
    [ownerId]
  );

  if (result.rowCount === 0) {
    throw new AppError(403, 'OWNER_NOT_FOUND', 'Owner is not registered');
  }

  const owner = result.rows[0];
  if (owner.status !== 'active') {
    throw new AppError(403, 'OWNER_NOT_ACTIVE', 'Owner is not active', {
      status: owner.status
    });
  }

  return owner;
}
