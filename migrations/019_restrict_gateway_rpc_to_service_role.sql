revoke all on function public.gateway_runtime_authorize(text, text) from public;
revoke all on function public.gateway_runtime_authorize(text, text) from anon;
revoke all on function public.gateway_runtime_authorize(text, text) from authenticated;
grant execute on function public.gateway_runtime_authorize(text, text) to service_role;

revoke all on function public.gateway_runtime_op(text, text, text, jsonb) from public;
revoke all on function public.gateway_runtime_op(text, text, text, jsonb) from anon;
revoke all on function public.gateway_runtime_op(text, text, text, jsonb) from authenticated;
grant execute on function public.gateway_runtime_op(text, text, text, jsonb) to service_role;
