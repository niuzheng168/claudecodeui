import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/index.js';
import { AppError, readObjectRecord } from '@/shared/index.js';

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Claude Code's own default window, and the range it clamps
// CLAUDE_CODE_AUTO_COMPACT_WINDOW to.
const CLAUDE_CODE_STANDARD_WINDOW = 200_000;
const CLAUDE_CODE_MIN_COMPACT_WINDOW = 100_000;
// Claude Code compacts at window - min(max output, 20K) - a 13K buffer.
const CLAUDE_CODE_COMPACT_RESERVE = 20_000 + 13_000;
const AUTO_COMPACT_RATIO = 0.6;

/**
 * Used by the Claude runtime for managed models. Claude Code sizes its context
 * from the model id, not the gateway: it reads `claude-opus-5.5` as a 200K
 * model and auto-compacts near 167K even when the catalog reports 1M. A `[1m]`
 * suffix selects its 1M window (it strips the suffix and sends the context-1m
 * beta instead), and the compaction window makes auto-compact start at 60% of
 * the catalog's window. An explicit CLAUDE_CODE_AUTO_COMPACT_WINDOW wins.
 */
export function buildClaudeContextLaunch(
  model: string,
  contextWindow: number,
  env: NodeJS.ProcessEnv,
): { model: string; env: NodeJS.ProcessEnv } {
  const launchModel = contextWindow > CLAUDE_CODE_STANDARD_WINDOW && !/\[1m\]$/i.test(model)
    ? `${model}[1m]`
    : model;
  if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return { model: launchModel, env };
  const compactWindow = Math.min(contextWindow, Math.max(
    CLAUDE_CODE_MIN_COMPACT_WINDOW,
    Math.round(contextWindow * AUTO_COMPACT_RATIO) + CLAUDE_CODE_COMPACT_RESERVE,
  ));
  return {
    model: launchModel,
    env: { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactWindow) },
  };
}

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
  // Windows from the newest catalog read, for usage readers that only need a
  // display total. Runs always validate against a fresh catalog.
  let contextWindows: Map<string, number> | undefined;
  let contextWindowsRequest: Promise<unknown> | undefined;

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

  async function getModels(): Promise<ProviderModelsDefinition> {
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
      const capabilities = readObjectRecord(model.capabilities);
      const supports = readObjectRecord(capabilities?.supports);
      const efforts = Array.isArray(supports?.reasoning_effort)
        ? supports.reasoning_effort.filter((value): value is string => (
          typeof value === 'string' && CLAUDE_EFFORTS.has(value)
        ))
        : [];
      const contextWindow = readObjectRecord(capabilities?.limits)?.max_context_window_tokens;
      options.push({
        value: model.id,
        label: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
        description: 'Claude Code harness · Codey Messages API',
        ...(Number.isSafeInteger(contextWindow) && Number(contextWindow) > 0
          ? { contextWindow: Number(contextWindow) }
          : {}),
        ...(efforts.length ? {
          effort: {
            default: efforts.includes('high') ? 'high' : efforts[0],
            values: [...new Set(efforts)].map(value => ({ value })),
          },
        } : {}),
      });
    }
    contextWindows = new Map(options.flatMap(option => (
      option.contextWindow ? [[option.value, option.contextWindow] as const] : []
    )));
    // No fallback to a public Anthropic model or another harness when unavailable.
    return { OPTIONS: options, DEFAULT: options[0]?.value ?? '', modelApiManaged: true };
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

    getModels,

    /**
     * Used by the Claude usage readers to label a session's counter. Reads the
     * catalog once when none has been loaded; undefined when it is unavailable
     * or does not report this model's window.
     */
    async getContextWindow(model: string | null | undefined): Promise<number | undefined> {
      if (environment().CODEY_MANAGED !== 'true' || !model) return undefined;
      if (!contextWindows) {
        contextWindowsRequest ??= getModels().catch(() => undefined)
          .finally(() => { contextWindowsRequest = undefined; });
        await contextWindowsRequest;
      }
      return contextWindows?.get(model);
    },
  };
}

/** Shared by the Claude auth, model catalog and SDK runtime adapters. */
export const codeyClaudeGateway = createCodeyClaudeGateway();
