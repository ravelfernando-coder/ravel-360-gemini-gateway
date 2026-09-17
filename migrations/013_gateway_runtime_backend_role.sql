do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ravel_gateway_runtime') then
    create role ravel_gateway_runtime
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      connection limit 5;
  end if;
end
$$;

grant connect on database postgres to ravel_gateway_runtime;
grant usage on schema public to ravel_gateway_runtime;

grant select on public.schema_migrations to ravel_gateway_runtime;
grant select on public.gateway_owners to ravel_gateway_runtime;
grant select, insert, update on public.gateway_requests to ravel_gateway_runtime;
grant select, insert, update on public.idempotency_keys to ravel_gateway_runtime;
grant insert on public.audit_events to ravel_gateway_runtime;
grant insert on public.provider_calls to ravel_gateway_runtime;
grant select on public.gateway_request_state_transitions to ravel_gateway_runtime;
grant usage, select on sequence public.audit_events_id_seq to ravel_gateway_runtime;

create policy gateway_backend_schema_migrations on public.schema_migrations
  for select to ravel_gateway_runtime using (true);

create policy gateway_backend_gateway_owners on public.gateway_owners
  for select to ravel_gateway_runtime using (true);

create policy gateway_backend_gateway_requests on public.gateway_requests
  for all to ravel_gateway_runtime
  using (true) with check (true);

create policy gateway_backend_idempotency_keys on public.idempotency_keys
  for all to ravel_gateway_runtime
  using (true) with check (true);

create policy gateway_backend_audit_events on public.audit_events
  for insert to ravel_gateway_runtime with check (true);

create policy gateway_backend_provider_calls on public.provider_calls
  for insert to ravel_gateway_runtime with check (true);

create policy gateway_backend_state_transitions on public.gateway_request_state_transitions
  for select to ravel_gateway_runtime using (true);
