import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import { AntigravityProviderModels } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import { AntigravityMcpProvider } from '@/modules/providers/list/antigravity/antigravity-mcp.provider.js';
import { antigravityRuntime } from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';
import { AntigravitySessionsProvider, AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { AntigravitySkillsProvider } from '@/modules/providers/list/antigravity/antigravity-skills.provider.js';

/** Provider registry entry for Google's official Antigravity SDK. */
export class AntigravityProvider extends AbstractProvider {
  readonly runtime = antigravityRuntime;
  readonly models = new AntigravityProviderModels();
  readonly auth = new AntigravityProviderAuth();
  readonly mcp = new AntigravityMcpProvider();
  readonly skills = new AntigravitySkillsProvider();
  readonly sessions = new AntigravitySessionsProvider();
  readonly sessionSynchronizer = new AntigravitySessionSynchronizer();

  constructor() { super('antigravity'); }
}
