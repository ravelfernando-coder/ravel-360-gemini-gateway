create index if not exists idempotency_keys_request_id_idx
  on public.idempotency_keys(request_id);
