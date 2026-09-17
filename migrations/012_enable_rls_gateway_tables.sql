alter table public.schema_migrations enable row level security;

alter table public.gateway_owners enable row level security;

alter table public.gateway_requests enable row level security;

alter table public.idempotency_keys enable row level security;

alter table public.audit_events enable row level security;

alter table public.provider_calls enable row level security;

alter table public.gateway_request_state_transitions enable row level security;
