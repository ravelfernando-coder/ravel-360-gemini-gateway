import { query } from './db.js';
import { gatewayRpc, useSupabaseRpc } from './remote-persistence.js';

export async function recordAuditEvent(event, options = {}) {
  if (useSupabaseRpc(options.config)) {
    return gatewayRpc(
      'record_audit',
      event.ownerId ?? options.ownerId ?? process.env.RAVEL_DEFAULT_OWNER_ID,
      {
        request_id: event.requestId ?? null,
        event_type: event.eventType,
        actor_id: event.actorId ?? null,
        severity: event.severity ?? 'info',
        details: event.details ?? {}
      },
      options
    );
  }

  const dbQuery = options.query ?? query;
  return dbQuery(
    `insert into audit_events
      (owner_id, request_id, event_type, actor_id, severity, details)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.ownerId ?? null,
      event.requestId ?? null,
      event.eventType,
      event.actorId ?? null,
      event.severity ?? 'info',
      JSON.stringify(event.details ?? {})
    ]
  );
}
