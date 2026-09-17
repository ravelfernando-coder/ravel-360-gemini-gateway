import test from 'node:test';
import assert from 'node:assert/strict';
import { createFortesConectaAdapter } from '../api/lib/adapters/fortes-conecta.js';

test('Fortes Conecta adapter reports safe read-only status when unconfigured', async () => {
  const adapter = createFortesConectaAdapter({
    FORTES_CONECTA_BASE_URL: 'https://conecta.fortestecnologia.com.br'
  });
  const status = await adapter.integrationStatus();
  assert.equal(status.provider, 'fortes_conecta');
  assert.equal(status.configured, false);
  assert.equal(status.mode, 'read_only');
  assert.equal(status.capabilities.writes, false);
});

test('Fortes Conecta adapter builds the documented OAuth request', async () => {
  const adapter = createFortesConectaAdapter({
    FORTES_CONECTA_BASE_URL: 'https://conecta.example',
    FORTES_CONECTA_CLIENT_ID: 'client-id',
    FORTES_CONECTA_CLIENT_SECRET: 'credential-value',
    FORTES_CONECTA_COMPANY_CNPJ: '12345678000100'
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ access_token: 'token-value' }), { status: 200 });
  };
  try {
    const result = await adapter.authenticate();
    assert.equal(result.access_token, 'token-value');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://conecta.example/api/v2/login');
    assert.equal(calls[0].options.method, 'POST');
    assert.match(calls[0].options.body, /grant_type=empresacontabil/);
    assert.match(calls[0].options.body, /client_id=client-id/);
    assert.match(calls[0].options.body, /empresacontabil_cnpj=12345678000100/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
