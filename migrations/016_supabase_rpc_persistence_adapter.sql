create table if not exists public.gateway_runtime_credentials (
  owner_id text primary key references public.gateway_owners(owner_id) on update cascade on delete cascade,
  secret_hash bytea not null,
  status text not null default 'active',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint gateway_runtime_credentials_status_check
    check (status in ('active', 'disabled'))
);

alter table public.gateway_runtime_credentials enable row level security;

drop policy if exists gateway_runtime_credentials_backend
  on public.gateway_runtime_credentials;
create policy gateway_runtime_credentials_backend
  on public.gateway_runtime_credentials
  for all to ravel_gateway_runtime
  using (true) with check (true);

create or replace function public.gateway_runtime_authorize(
  p_gateway_secret text,
  p_owner_id text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.gateway_runtime_credentials c
     where c.owner_id = p_owner_id
       and c.status = 'active'
       and c.secret_hash = public.digest(p_gateway_secret, 'sha256')
  );
$$;

create or replace function public.gateway_runtime_op(
  p_gateway_secret text,
  p_owner_id text,
  p_operation text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_row public.gateway_owners%rowtype;
  request_row public.gateway_requests%rowtype;
  idem_row public.idempotency_keys%rowtype;
  affected integer;
begin
  if p_gateway_secret is null
     or pg_catalog.length(pg_catalog.btrim(p_gateway_secret)) = 0
  then
    return jsonb_build_object('ok', false, 'code', 'GATEWAY_SECRET_REQUIRED');
  end if;

  if not public.gateway_runtime_authorize(p_gateway_secret, p_owner_id) then
    return jsonb_build_object('ok', false, 'code', 'GATEWAY_UNAUTHORIZED');
  end if;

  if p_operation = 'health' then
    return jsonb_build_object(
      'ok', true,
      'database_name', pg_catalog.current_database(),
      'checked_at', pg_catalog.now(),
      'latest_schema_migration', (
        select version
          from public.schema_migrations
         order by applied_at desc, version desc
         limit 1
      )
    );

  elsif p_operation = 'verify_owner' then
    select *
      into owner_row
      from public.gateway_owners
     where owner_id = p_owner_id
     limit 1;

    if not found then
      return jsonb_build_object('ok', false, 'code', 'OWNER_NOT_FOUND');
    end if;

    if owner_row.status <> 'active' then
      return jsonb_build_object(
        'ok', false,
        'code', 'OWNER_NOT_ACTIVE',
        'status', owner_row.status
      );
    end if;

    return jsonb_build_object(
      'ok', true,
      'owner_id', owner_row.owner_id,
      'status', owner_row.status
    );

  elsif p_operation = 'create_request' then
    insert into public.gateway_requests
      (request_id, owner_id, canonical_hash, operation, state, payload)
    values
      (
        p_payload->>'request_id',
        p_owner_id,
        p_payload->>'canonical_hash',
        p_payload->>'operation',
        'received',
        coalesce(p_payload->'payload', '{}'::jsonb)
      )
    on conflict (request_id) do nothing;

    select *
      into request_row
      from public.gateway_requests
     where request_id = p_payload->>'request_id';

    if not found then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
    end if;

    if request_row.owner_id <> p_owner_id
       or request_row.canonical_hash <> (p_payload->>'canonical_hash')::char(64)
    then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_CONFLICT');
    end if;

    return jsonb_build_object(
      'ok', true,
      'request_id', request_row.request_id,
      'owner_id', request_row.owner_id,
      'canonical_hash', request_row.canonical_hash,
      'state', request_row.state
    );

  elsif p_operation = 'update_request_state' then
    update public.gateway_requests
       set state = p_payload->>'state',
           response = case when p_payload ? 'response' then p_payload->'response' else response end,
           error = case when p_payload ? 'error' then p_payload->'error' else error end,
           completed_at = case
             when p_payload->>'state' in ('succeeded', 'failed') then pg_catalog.now()
             else completed_at
           end,
           updated_at = pg_catalog.now()
     where request_id = p_payload->>'request_id'
       and owner_id = p_owner_id;

    get diagnostics affected = row_count;
    return jsonb_build_object('ok', true, 'row_count', affected);

  elsif p_operation = 'reserve_idempotency' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_payload->>'key')::bigint
    );

    select *
      into idem_row
      from public.idempotency_keys
     where key = p_payload->>'key'
     for update;

    if found then
      if idem_row.owner_id <> p_owner_id
         or idem_row.canonical_hash <> (p_payload->>'canonical_hash')::char(64)
      then
        return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_CONFLICT');
      end if;

      if idem_row.status = 'completed' then
        return jsonb_build_object(
          'ok', true,
          'status', 'cached',
          'response_status', idem_row.response_status,
          'response_body', idem_row.response_body
        );
      end if;

      if idem_row.status = 'in_progress'
         and idem_row.expires_at > pg_catalog.now()
      then
        return jsonb_build_object(
          'ok', false,
          'code', 'IDEMPOTENCY_IN_PROGRESS'
        );
      end if;

      update public.idempotency_keys
         set status = 'in_progress',
             response_status = null,
             response_body = null,
             last_error = null,
             attempt_count = attempt_count + 1,
             expires_at = pg_catalog.now() +
               (coalesce((p_payload->>'ttl_seconds')::integer, 86400) * interval '1 second'),
             updated_at = pg_catalog.now()
       where key = p_payload->>'key';

      return jsonb_build_object('ok', true, 'status', 'reserved');
    end if;

    insert into public.idempotency_keys
      (key, owner_id, canonical_hash, request_id, status, expires_at)
    values
      (
        p_payload->>'key',
        p_owner_id,
        p_payload->>'canonical_hash',
        p_payload->>'request_id',
        'in_progress',
        pg_catalog.now() +
          (coalesce((p_payload->>'ttl_seconds')::integer, 86400) * interval '1 second')
      );

    return jsonb_build_object('ok', true, 'status', 'reserved');

  elsif p_operation = 'complete_idempotency' then
    update public.idempotency_keys
       set status = 'completed',
           response_status = (p_payload->>'response_status')::integer,
           response_body = p_payload->'response_body',
           updated_at = pg_catalog.now()
     where key = p_payload->>'key'
       and owner_id = p_owner_id
       and canonical_hash = (p_payload->>'canonical_hash')::char(64)
       and status = 'in_progress';

    get diagnostics affected = row_count;
    return jsonb_build_object('ok', true, 'row_count', affected);

  elsif p_operation = 'fail_idempotency' then
    update public.idempotency_keys
       set status = 'failed',
           last_error = p_payload->'error',
           updated_at = pg_catalog.now()
     where key = p_payload->>'key'
       and owner_id = p_owner_id
       and canonical_hash = (p_payload->>'canonical_hash')::char(64)
       and status = 'in_progress';

    get diagnostics affected = row_count;
    return jsonb_build_object('ok', true, 'row_count', affected);

  elsif p_operation = 'record_audit' then
    insert into public.audit_events
      (owner_id, request_id, event_type, actor_id, severity, details)
    values
      (
        p_owner_id,
        p_payload->>'request_id',
        p_payload->>'event_type',
        p_payload->>'actor_id',
        coalesce(p_payload->>'severity', 'info'),
        coalesce(p_payload->'details', '{}'::jsonb)
      );

    return jsonb_build_object('ok', true);

  elsif p_operation = 'record_provider_call' then
    insert into public.provider_calls
      (request_id, provider, model, status, http_status, attempt_count, latency_ms, error)
    values
      (
        p_payload->>'request_id',
        p_payload->>'provider',
        p_payload->>'model',
        p_payload->>'status',
        (p_payload->>'http_status')::integer,
        (p_payload->>'attempt_count')::integer,
        (p_payload->>'latency_ms')::integer,
        p_payload->'error'
      );

    return jsonb_build_object('ok', true);
  end if;

  return jsonb_build_object('ok', false, 'code', 'UNKNOWN_GATEWAY_OPERATION');
end;
$$;

revoke all on function public.gateway_runtime_authorize(text, text) from public;
revoke all on function public.gateway_runtime_op(text, text, text, jsonb) from public;
grant execute on function public.gateway_runtime_authorize(text, text) to anon, authenticated;
grant execute on function public.gateway_runtime_op(text, text, text, jsonb) to anon, authenticated;
