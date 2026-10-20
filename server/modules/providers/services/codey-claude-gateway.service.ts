import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/index.js';
import { AppError, readObjectRecord } from '@/shared/index.js';

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Used by the Claude model, auth and runtime adapters. A managed node's model
 * gateway owns credentials/upstream routing; the Claude harness only consumes
 * its Messages API. Tests inject the environment and HTTP transport.
 */
export function createCodeyClaudeGateway(dependencies: {
  environment?: () => NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
} = {}) {
  const environment = dependencies.environment ?? (() => process.env);
  const fetchModels = dependencies.fetch ?? globalThis.fetch;

  function configuration() {
    const env = environment();
    const key = env.CODEY_MODEL_API_KEY?.trim();
    if (!key) {
      throw new AppError('The Codey model API key is not configured.', {
        code: 'CODEY_MODEL_API_UNCONFIGURED', statusCode: 503,
      });
    }
    let url: URL;
    try {
      url = new URL(env.CODEY_MODEL_BASE_URL || 'http://127.0.0.1:4141');
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
        throw new Error('Invalid gateway URL');
      }
    } catch {
      throw new AppError('Codey requires an HTTPS or loopback model API URL.', {
        code: 'CODEY_MODEL_API_URL_INVALID', statusCode: 503,
      });
    }
    return { key, baseUrl: url.toString().replace(/\/$/, '') };
  }

  return {
    isManaged: () => environment().CODEY_MANAGED === 'true',

    buildEnvironment(): NodeJS.ProcessEnv {
      const env = { ...environment() };
      if (env.CODEY_MANAGED !== 'true') return env;
      const { key, baseUrl } = configuration();
      // Per-child values only: never edit the user's Claude login or settings.
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = key;
      env.ANTHROPIC_API_KEY = '';
      env.CLAUDE_CODE_OAUTH_TOKEN = '';
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      for (const name of [
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      ]) delete env[name];
      return env;
    },

    async getModels(): Promise<ProviderModelsDefinition> {
      const { key, baseUrl } = configuration();
      let response: Response;
      try {
        response = await fetchModels(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000), redirect: 'error',
        });
      } catch {
        throw new AppError('The Codey model API is unavailable.', {
          code: 'CODEY_MODEL_API_UNAVAILABLE', statusCode: 503,
        });
      }
      if (!response.ok) {
        throw new AppError(`The Codey model API returned HTTP ${response.status}.`, {
          code: 'CODEY_MODEL_API_UNAVAILABLE', statusCode: 503,
        });
      }
      let body: Record<string, unknown> | null;
      try { body = readObjectRecord(await response.json()); }
      catch { body = null; }
      if (!Array.isArray(body?.data)) {
        throw new AppError('The Codey model catalog is invalid.', {
          code: 'CODEY_MODEL_CATALOG_INVALID', statusCode: 502,
        });
      }
      const options: ProviderModelOption[] = [];
      const seen = new Set<string>();
      for (const item of body.data) {
        const model = readObjectRecord(item);
        if (typeof model?.id !== 'string' || !/(^|\/)claude[-/]/i.test(model.id)
          || !Array.isArray(model.supported_endpoints)
          || !model.supported_endpoints.includes('/v1/messages') || seen.has(model.id)) continue;
        seen.add(model.id);
        const supports = readObjectRecord(readObjectRecord(model.capabilities)?.supports);
        const efforts = Array.isArray(supports?.reasoning_effort)
          ? supports.reasoning_effort.filter((value): value is string => (
            typeof value === 'string' && CLAUDE_EFFORTS.has(value)
          ))
          : [];
        options.push({
          value: model.id,
          label: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
          description: 'Claude Code harness · Codey Messages API',
          ...(efforts.length ? {
            effort: {
              default: efforts.includes('high') ? 'high' : efforts[0],
              values: [...new Set(efforts)].map(value => ({ value })),
            },
          } : {}),
        });
      }
      // No fallback to a public Anthropic model or another harness when unavailable.
      return { OPTIONS: options, DEFAULT: options[0]?.value ?? '', modelApiManaged: true };
    },
  };
}

/** Shared by the Claude auth, model catalog and SDK runtime adapters. */
export const codeyClaudeGateway = createCodeyClaudeGateway();
