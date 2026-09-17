import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRpc, useSupabaseRpc } from '../api/lib/remote-persistence.js';

const config = {
  persistenceBackend: 'supabase_rpc',
  supabaseUrl: 'https://example.supabase.co',
  supabaseRuntimeFunctionUrl:
    'https://example.supabase.co/functions/v1/ravel360-gateway-runtime-op',
  supabasePublishableKey: 'publishable',
  ravelGatewaySecret: 'secret',
  requestTimeoutMs: 1000
};

test('gatewayRpc uses the protected runtime Edge Function', async () => {
  assert.equal(useSupabaseRpc(config), true);

  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        ok: true,
        database_name: 'postgres',
        latest_schema_migration: '019_restrict_gateway_rpc_to_service_role'
      }),
      { status: 200 }
    );
  };

  const result = await gatewayRpc('health', 'owner-canary', {}, { config, fetch });
  assert.equal(result.ok, true);
  assert.equal(result.database_name, 'postgres');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.supabaseRuntimeFunctionUrl);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.p_operation, 'health');
  assert.equal(body.p_owner_id, 'owner-canary');
  assert.equal(body.p_gateway_secret, 'secret');
});

test('gatewayRpc converts runtime authorization failures to AppError', async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        code: 'GATEWAY_UNAUTHORIZED'
      }),
      { status: 200 }
    );

  await assert.rejects(
    () => gatewayRpc('health', 'owner-canary', {}, { config, fetch }),
    (error) => error.code === 'GATEWAY_UNAUTHORIZED' && error.statusCode === 401
  );
});
