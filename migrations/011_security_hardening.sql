create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

create or replace function public.enforce_gateway_request_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = new.state then
    return new;
  end if;

  if not exists (
    select 1
      from public.gateway_request_state_transitions
     where from_state = old.state
       and to_state = new.state
  ) then
    raise exception 'invalid gateway request state transition from % to %', old.state, new.state
      using errcode = '23514';
  end if;

  return new;
end;
$$;
