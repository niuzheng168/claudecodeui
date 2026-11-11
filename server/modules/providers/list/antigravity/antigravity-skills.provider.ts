import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/index.js';

/** Registry/settings share the same skill roots passed to the SDK runtime. */
export class AntigravitySkillsProvider extends SkillsProvider {
  constructor() { super('antigravity'); }

  protected async getSkillSources(workspace: string): Promise<ProviderSkillSource[]> {
    return [
      { scope: 'project', rootDir: path.join(workspace, '.agents', 'skills'), commandPrefix: '$' },
      await this.getGlobalSkillSource(),
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: path.join(os.homedir(), '.agents', 'skills'), commandPrefix: '$' };
  }
}
