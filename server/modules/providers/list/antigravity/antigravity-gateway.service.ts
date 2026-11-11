import { readBoundedJsonResponse, readCodeyModelApiConfiguration, readObjectRecord } from '@/shared/index.js';
import type { ProviderModelsDefinition, ProviderModelOption } from '@/shared/index.js';
import { startAntigravityCopilotBridge } from '@/modules/providers/list/antigravity/antigravity-copilot-bridge.service.js';

/** Auth, catalog and runtime share the same managed gateway, never ambient Google credentials. */
export function createAntigravityGateway(dependencies: {
  environment?: () => NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
} = {}) {
  const environment = dependencies.environment ?? (() => process.env);
  const request = dependencies.fetch ?? globalThis.fetch;
  async function getModels(): Promise<ProviderModelsDefinition> {
    const { key, baseUrl } = readCodeyModelApiConfiguration(environment());
    let response: Response;
    try {
      response = await request(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error('The Codey model API is unavailable. Check the Copilot proxy.'); }
    if (!response.ok) throw new Error(`The Codey model API returned HTTP ${response.status}.`);
    const body = await readBoundedJsonResponse(response, 4 * 1024 * 1024).catch(() => null);
    if (!Array.isArray(body?.data)) throw new Error('Invalid Codey model catalog.');
    const options: ProviderModelOption[] = [];
    for (const raw of body.data) {
      const model = readObjectRecord(raw);
      if (typeof model?.id !== 'string' || !/(^|\/)gemini-/i.test(model.id)
        || options.some(option => option.value === model.id)
        || readObjectRecord(model.policy)?.state === 'disabled'
        || model.model_picker_enabled === false
        || !Array.isArray(model.supported_endpoints)
        || !model.supported_endpoints.includes('/chat/completions')) continue;
      const capabilities = readObjectRecord(model.capabilities);
      const supports = readObjectRecord(capabilities?.supports);
      const efforts = Array.isArray(supports?.reasoning_effort)
        ? supports.reasoning_effort.filter((v): v is string => (
          typeof v === 'string' && ['minimal', 'low', 'medium', 'high', 'extra_high'].includes(v)
        )) : [];
      options.push({
        value: model.id, label: typeof model.name === 'string' ? model.name : model.id,
        description: 'Antigravity SDK · Copilot proxy (no Google login)',
        ...(efforts.length ? { effort: { default: efforts.includes('high') ? 'high' : efforts[0],
          values: [...new Set(efforts)].map(value => ({ value })) } } : {}),
      });
    }
    options.sort((a, b) => Number(b.value === 'gemini-4-carbon') - Number(a.value === 'gemini-4-carbon'));
    return { OPTIONS: options, DEFAULT: options[0]?.value ?? '', modelApiManaged: true };
  }
  return {
    isManaged: () => environment().CODEY_MANAGED === 'true',
    getModels,
    async open(model: string, effort?: string) {
      const option = (await getModels()).OPTIONS.find(item => item.value === model);
      if (!option) throw new Error(`The Copilot proxy does not offer ${model}. Check Copilot model access and proxy discovery; Google login is not required.`);
      if (effort && !option.effort?.values.some(value => value.value === effort)) {
        throw new Error(`The Copilot proxy does not offer thinking level ${effort} for ${model}.`);
      }
      return startAntigravityCopilotBridge({
        ...readCodeyModelApiConfiguration(environment()), model, effort, fetch: request,
      });
    },
  };
}

/** Provider registry facets use this host-owned gateway instance. */
export const antigravityGateway = createAntigravityGateway();
