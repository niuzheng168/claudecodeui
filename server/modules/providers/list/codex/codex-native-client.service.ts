import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { AppError } from '@/shared/index.js';
import type { ICodexRpcClient } from '@/shared/index.js';

/**
 * Used by Codex execution, discovery and history on every platform. Prefer the
 * existing owner; when its default socket is absent, use the configured native
 * CLI with the same CODEX_HOME. An explicit socket or a failed native handshake
 * must never select another backend. Only unconfigured legacy installs return
 * null; callers must not send native histories through exec.
 */
export async function connectCodexNativeClient(): Promise<ICodexRpcClient | null> {
  const transport = process.env.CODEY_CODEX_RUNTIME_TRANSPORT;
  if (transport !== undefined && transport !== '') {
    if (transport !== 'stdio' || process.env.CODEY_CODEX_DAEMON_SOCKET) {
      throw new AppError('The configured Codex execution transport is invalid or ambiguous; no alternate runtime was started.', {
        code: 'CODEX_RUNTIME_TRANSPORT_INVALID', statusCode: 503,
      });
    }
    return CodexStdioClient.connect();
  }
  const owner = await CodexDaemonClient.connect();
  if (owner) return owner;
  return process.env.CODEY_CODEX_EXECUTABLE ? CodexStdioClient.connect() : null;
}
