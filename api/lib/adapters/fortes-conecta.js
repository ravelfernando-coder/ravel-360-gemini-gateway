import { DependencyUnavailableError } from '../errors.js';

const DEFAULT_BASE_URL = 'https://conecta.fortestecnologia.com.br';

function requireConfig(config) {
  const missing = ['clientId', 'clientSecret', 'companyCnpj'].filter((key) => !config[key]);
  if (missing.length) {
    throw new DependencyUnavailableError(
      'FORTES_CONFIG_INCOMPLETE',
      'Fortes Conecta API credentials are not configured'
    );
  }
}

export function createFortesConectaAdapter(env = process.env) {
  const config = {
    baseUrl: String(env.FORTES_CONECTA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    clientId: String(env.FORTES_CONECTA_CLIENT_ID || '').trim(),
    clientSecret: String(env.FORTES_CONECTA_CLIENT_SECRET || '').trim(),
    companyCnpj: String(env.FORTES_CONECTA_COMPANY_CNPJ || '').trim(),
    timeoutMs: Number.parseInt(env.FORTES_CONECTA_TIMEOUT_MS || '15000', 10)
  };

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(config.baseUrl + path, {
        ...options,
        signal: controller.signal
      });
      const body = await response.text();
      let data = body;
      try {
        data = body ? JSON.parse(body) : {};
      } catch {}
      if (!response.ok) {
        throw new Error('FORTES_HTTP_' + response.status);
      }
      return { status: response.status, data };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new DependencyUnavailableError('FORTES_TIMEOUT', 'Fortes Conecta request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function authenticate() {
    requireConfig(config);
    const body = new URLSearchParams({
      grant_type: 'empresacontabil',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      empresacontabil_cnpj: config.companyCnpj
    }).toString();

    const result = await request('/api/v2/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!result.data?.access_token) {
      throw new Error('FORTES_AUTH_TOKEN_MISSING');
    }

    return result.data;
  }

  async function listClientCompanies() {
    const token = await authenticate();
    const result = await request('/api/v2/EmpresaContabil/listarempresascliente', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token.access_token }
    });
    return {
      authenticated: true,
      status: result.status,
      count: Array.isArray(result.data) ? result.data.length : null,
      data: result.data
    };
  }

  async function integrationStatus() {
    const configured = Boolean(config.clientId && config.clientSecret && config.companyCnpj);
    return {
      provider: 'fortes_conecta',
      configured,
      baseUrl: config.baseUrl,
      mode: 'read_only',
      capabilities: { authenticate: true, listClientCompanies: true, writes: false }
    };
  }

  return { authenticate, listClientCompanies, integrationStatus };
}
