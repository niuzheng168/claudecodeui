import { spawnSync } from 'node:child_process';

import type { CliVersionProbe, IProviderAuth, ProviderAuthStatus } from '@/shared/index.js';
import {
  antigravityBridge, antigravityPython, readAntigravityCredentials,
} from '@/modules/providers/list/antigravity/antigravity-settings.service.js';

/** The registry/settings report the official SDK's installation and Google credentials. */
export class AntigravityProviderAuth implements IProviderAuth {
  checkInstalled(): CliVersionProbe {
    const result = spawnSync(antigravityPython(), [antigravityBridge(), '--version'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    const version = result.status === 0 ? result.stdout.trim() : null;
    return { installed: version === '0.1.23', version, exitCode: result.status };
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const probe = this.checkInstalled();
    const status: ProviderAuthStatus = {
      provider: 'antigravity', installed: probe.installed,
      installedVersion: probe.version, authenticated: false, email: null, method: null,
    };
    try {
      const credentials = readAntigravityCredentials();
      status.authenticated = probe.installed && Boolean(credentials.vertex
        ? credentials.project && credentials.location
        : credentials.apiKey);
      status.method = credentials.vertex ? 'vertex_adc' : credentials.apiKey ? 'gemini_api_key' : null;
      if (!status.authenticated) status.error = probe.installed
        ? 'Configure a Gemini API key with codey antigravity login, or Vertex AI project/location and ADC.'
        : 'Install the Google Antigravity SDK with codey antigravity install.';
    } catch (error) {
      status.error = error instanceof Error ? error.message : 'Invalid Antigravity settings.';
    }
    return status;
  }
}
