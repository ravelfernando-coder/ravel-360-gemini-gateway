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
       and c.secret_hash = extensions.digest(p_gateway_secret, 'sha256')
  );
$$;
