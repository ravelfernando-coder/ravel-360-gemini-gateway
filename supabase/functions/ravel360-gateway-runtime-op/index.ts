import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  if (!keys.default || req.headers.get('apikey') !== keys.default) {
    return new Response(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const serviceKey = secretKeys.default;
  if (!serviceKey) {
    return new Response(JSON.stringify({ ok: false, code: 'SERVICE_KEY_UNAVAILABLE' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const input = await req.json();
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
  const { data, error } = await supabase.rpc('gateway_runtime_op', input);

  if (error) {
    return new Response(JSON.stringify({ ok: false, code: 'RPC_ERROR', message: error.message }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  return new Response(JSON.stringify(data ?? {}), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
});
