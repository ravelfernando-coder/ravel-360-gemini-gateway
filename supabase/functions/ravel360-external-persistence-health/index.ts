import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const expectedKey = keys.default;
  const suppliedKey = req.headers.get('apikey');

  if (!expectedKey || suppliedKey !== expectedKey) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const secretKey = secretKeys.default;
  if (!secretKey) {
    return new Response(JSON.stringify({ ok: false, error: 'server_secret_unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', secretKey);
  const started = performance.now();
  const { data, error } = await supabase
    .from('schema_migrations')
    .select('version')
    .order('version', { ascending: false })
    .limit(1);

  if (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        service: 'ravel360-external-persistence-health',
        database: 'error',
        error: error.message
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      service: 'ravel360-external-persistence-health',
      database: 'reachable',
      latest_schema_migration: data?.[0]?.version ?? null,
      latency_ms: Math.round(performance.now() - started),
      runtime_dependencies: {
        supabase_db_url: Boolean(Deno.env.get('SUPABASE_DB_URL')),
        gemini_api_key: Boolean(Deno.env.get('GEMINI_API_KEY')),
        gateway_secret: Boolean(Deno.env.get('RAVEL_GATEWAY_SECRET'))
      }
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    }
  );
});
