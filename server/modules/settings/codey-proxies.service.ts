import fs from 'node:fs/promises';
import path from 'node:path';

import { AppError, readObjectRecord } from '@/shared/index.js';

/** Settings' owner-only router uses this adapter; the model API owns the actual file. */
export function createCodeyProxiesService(dependencies: {
  environment?: NodeJS.ProcessEnv;
  readConfig?: (file: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
} = {}) {
  const environment = dependencies.environment ?? process.env;
  const readConfig = dependencies.readConfig ?? ((file: string) => fs.readFile(file, 'utf8'));
  const fetchGateway = dependencies.fetch ?? globalThis.fetch;

  async function transfer(method: 'GET' | 'PUT', body?: unknown) {
    if (environment.CODEY_MANAGED !== 'true') {
      throw new AppError('Node proxy settings are available only in Codey.', { statusCode: 403, code: 'CODEY_REQUIRED' });
    }
    const home = environment.COPILOT_API_HOME;
    if (!home || !path.isAbsolute(home)) {
      throw new AppError('The local model API configuration is unavailable.', { statusCode: 503, code: 'GATEWAY_UNCONFIGURED' });
    }
    let key: string;
    let endpoint: URL;
    try {
      const config = readObjectRecord(JSON.parse((await readConfig(path.join(home, 'config.json'))).replace(/^\uFEFF/, '')));
      const auth = readObjectRecord(config?.auth);
      if (typeof auth?.adminApiKey !== 'string' || !auth.adminApiKey.trim()) throw new Error();
      key = auth.adminApiKey;
      endpoint = new URL(environment.CODEY_GATEWAY_ADMIN_URL || 'http://127.0.0.1:4141');
      // This is always the current node's control plane, never the configurable inference proxy.
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
        || !['http:', 'https:'].includes(endpoint.protocol)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || endpoint.pathname !== '/') throw new Error();
    } catch {
      throw new AppError('The local model API admin configuration is invalid.', { statusCode: 503, code: 'GATEWAY_UNCONFIGURED' });
    }

    let response: Response;
    try {
      response = await fetchGateway(new URL('/admin/config/codey-settings', endpoint), {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch {
      throw new AppError('The local model API is unavailable.', { statusCode: 503, code: 'GATEWAY_UNAVAILABLE' });
    }
    if (!response.ok) {
      const message = response.status === 404
        ? 'The installed model API does not yet support file-backed proxy settings.'
        : response.status === 409
          ? 'The node settings changed. Reload before saving.'
          : response.status === 400
            ? 'Invalid proxy settings. Check endpoints, keys, model IDs and duplicate routes.'
            : 'The node settings file cannot be read or saved. Check its JSON and permissions.';
      throw new AppError(message, {
        statusCode: response.status === 409 ? 409 : response.status === 400 ? 400 : 503,
        code: 'CODEY_PROXY_SETTINGS_FAILED',
      });
    }
    let result: Record<string, unknown> | null;
    try { result = readObjectRecord(await response.json()); } catch { result = null; }
    if (typeof result?.revision !== 'string' || !/^[a-f0-9]{64}$/.test(result.revision)
      || typeof result.settingsFile !== 'string' || !Array.isArray(result.additionalCopilotProxies)) {
      throw new AppError('Invalid model API settings response.', { statusCode: 502, code: 'GATEWAY_RESPONSE_INVALID' });
    }
    return {
      enabled: result.enabled === true, settingsFile: result.settingsFile, revision: result.revision,
      additionalCopilotProxies: result.additionalCopilotProxies.map((value: unknown) => {
        const proxy = readObjectRecord(value);
        if (typeof proxy?.id !== 'string' || typeof proxy.endpoint !== 'string' || !Array.isArray(proxy.models)
          || !proxy.models.every((model: unknown) => typeof model === 'string')) {
          throw new AppError('Invalid proxy metadata.', { statusCode: 502, code: 'GATEWAY_RESPONSE_INVALID' });
        }
        // Whitelist response fields. Even an older/misconfigured gateway cannot
        // send its raw key through this endpoint to the browser.
        return {
          id: proxy.id, endpoint: proxy.endpoint, models: proxy.models as string[],
          enabled: proxy.enabled === true, keyConfigured: proxy.keyConfigured === true,
        };
      }),
    };
  }

  return {
    read: () => transfer('GET'),
    save: (input: unknown) => transfer('PUT', input),
  };
}
