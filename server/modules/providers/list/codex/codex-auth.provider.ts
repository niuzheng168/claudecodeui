import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';
import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

/**
 * Resolves authentication for the active Codex custom provider. Used by
 * CodexProviderAuth and its provider-module tests so providers declaring
 * `requires_openai_auth = false` do not incorrectly prompt for OpenAI login.
 */
export function resolveCodexCustomProviderCredentials(
  configContent: string,
  environment: NodeJS.ProcessEnv,
): CodexCredentialsStatus | null {
  try {
    const config = readObjectRecord(TOML.parse(configContent));
    const providerName = readOptionalString(config?.model_provider);
    const providers = readObjectRecord(config?.model_providers);
    const provider = providerName ? readObjectRecord(providers?.[providerName]) : null;
    if (!providerName || !provider || provider.requires_openai_auth !== false) {
      return null;
    }

    const environmentKey = readOptionalString(provider.env_key);
    if (environmentKey && !environment[environmentKey]?.trim()) {
      return {
        authenticated: false,
        email: null,
        method: 'custom_provider',
        error: `Missing ${environmentKey} for Codex provider ${providerName}`,
      };
    }

    return {
      authenticated: true,
      email: providerName,
      method: 'custom_provider',
    };
  } catch {
    return null;
  }
}

export class CodexProviderAuth implements IProviderAuth {
  /**
   * Checks whether Codex is available to the server runtime.
   */
  private checkInstalled(): boolean {
    try {
      spawn.sync('codex', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Codex SDK availability and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Codex auth.json and checks OAuth tokens or an API key fallback.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');
      const customProvider = resolveCodexCustomProviderCredentials(
        await readFile(configPath, 'utf8'),
        process.env,
      );
      if (customProvider) {
        return customProvider;
      }
    } catch {
      // Fall through to the standard Codex auth.json check.
    }

    try {
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);

      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      if (readOptionalString(auth.OPENAI_API_KEY)) {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid tokens found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Codex not configured' : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}
