import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import {
  AppError, readJsonConfig, readObjectRecord, readOptionalString,
  readStringArray, readStringRecord, writeJsonConfig,
} from '@/shared/index.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/index.js';

const configPath = (scope: McpScope, workspace: string) => scope === 'user'
  ? path.join(os.homedir(), '.config', 'codey', 'antigravity-mcp.json')
  : path.join(workspace, '.antigravity', 'mcp.json');

/** The registry/settings edit MCP servers passed explicitly to each SDK run. */
export class AntigravityMcpProvider extends McpProvider {
  constructor() { super('antigravity', ['user', 'project'], ['stdio', 'http']); }

  protected async readScopedServers(scope: McpScope, workspace: string) {
    return readObjectRecord((await readJsonConfig(configPath(scope, workspace))).mcpServers) ?? {};
  }

  protected async writeScopedServers(scope: McpScope, workspace: string, servers: Record<string, unknown>) {
    const file = configPath(scope, workspace);
    await writeJsonConfig(file, { ...await readJsonConfig(file), mcpServers: servers });
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.name)) {
      throw new AppError('Google MCP names may contain only letters, numbers, underscores and hyphens.', {
        code: 'INVALID_MCP_NAME', statusCode: 400,
      });
    }
    if (input.cwd) {
      throw new AppError('The Antigravity SDK uses the workspace as the MCP working directory.', {
        code: 'MCP_CWD_UNSUPPORTED', statusCode: 400,
      });
    }
    if (input.transport === 'stdio' && input.command?.trim()) {
      return { command: input.command, args: input.args ?? [], env: input.env ?? {} };
    }
    if (input.transport === 'http' && input.url?.trim()) return { url: input.url, headers: input.headers ?? {} };
    throw new AppError('Provide an MCP command or HTTP URL.', { code: 'INVALID_MCP_CONFIG', statusCode: 400 });
  }

  protected normalizeServerConfig(scope: McpScope, name: string, raw: unknown): ProviderMcpServer | null {
    const value = readObjectRecord(raw);
    if (!value) return null;
    if (typeof value.command === 'string') return {
      provider: 'antigravity', scope, name, transport: 'stdio', command: value.command,
      args: readStringArray(value.args), env: readStringRecord(value.env),
    };
    const url = readOptionalString(value.url);
    return url ? { provider: 'antigravity', scope, name, transport: 'http', url, headers: readStringRecord(value.headers) } : null;
  }
}
