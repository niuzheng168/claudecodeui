import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { CliVersionProbe, IProviderAuth, ProviderAuthStatus } from '@/shared/index.js';
import { probeCliVersion, readObjectRecord, readOptionalString } from '@/shared/index.js';

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

/** Provider registry uses the same configured Codex CLI as the runtime for availability checks. */
export class CodexProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Codex CLI that chats run is available, and which version
   * it is. Codey supplies its owner's absolute executable; ordinary CloudCLI
   * falls back to the same guarded npm launcher the app-server adapter uses.
   * Never search PATH or hide a missing configured CLI with another install.
   */
  checkInstalled(): CliVersionProbe {
    const executable = process.env.CODEY_CODEX_EXECUTABLE;
    if (executable) {
      return path.isAbsolute(executable)
        ? probeCliVersion(executable)
        : { installed: false, exitCode: null, version: null };
    }
    let launcherPath: string;
    try {
      launcherPath = codexAppServer.resolveLauncher();
    } catch {
      return { installed: false, exitCode: null, version: null };
    }
    return probeCliVersion(process.execPath, [launcherPath, '--version']);
  }

  /**
   * Returns Codex SDK availability and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      installedVersion,
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
