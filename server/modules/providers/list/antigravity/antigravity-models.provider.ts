import type { IProviderModels, ProviderModelsDefinition } from '@/shared/index.js';
import { antigravityGateway } from '@/modules/providers/list/antigravity/antigravity-gateway.service.js';

/**
 * Google API model IDs (not Antigravity CLI's effort-suffixed slugs).
 * Verified against Google's model catalog; availability still depends on the
 * user's Google API account. Custom Google model IDs use the existing library.
 */
const MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gemini-4-carbon', label: 'Gemini 4 Carbon', description: 'Google · Antigravity SDK' },
    { value: 'gemini-4-argon', label: 'Gemini 4 Argon', description: 'Google · Antigravity SDK' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'Google · Antigravity SDK' },
  ].map(model => ({
    ...model,
    effort: { default: 'high', values: ['low', 'medium', 'high'].map(value => ({ value })) },
  })),
  DEFAULT: 'gemini-4-carbon',
};

/** The provider registry exposes Google models to the existing model picker. */
export class AntigravityProviderModels implements IProviderModels {
  constructor(private readonly gateway = antigravityGateway) {}

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (this.gateway.isManaged()) return this.gateway.getModels();
    return structuredClone(MODELS);
  }

  async getCurrentActiveModel() {
    return { model: (await this.getSupportedModels()).DEFAULT };
  }
}
