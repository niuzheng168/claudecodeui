import { lstat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import WebSocket from 'ws';

import type { AnyRecord } from '@/shared/types.js';
import { AppError, readObjectRecord, resolveCodexHomeDirectory } from '@/shared/utils.js';

type PendingRequest = {
  resolve(value: AnyRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Used by Codex discovery, history, and runtime adapters to talk to the daemon
 * that already owns desktop threads. Never starts/stops a daemon, modifies its
 * database, removes a writer lock, or retries a submitted turn.
 */
export class CodexDaemonClient {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Set<(method: string, params: AnyRecord) => void>();
  private readonly serverRequests = new Set<(method: string, params: AnyRecord) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private closedError: Error | null = null;

  private constructor(private readonly socket: WebSocket, private readonly requestTimeoutMs: number) {
    socket.on('message', (data) => {
      let message: AnyRecord | null;
      try {
        message = readObjectRecord(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (!message) return;

      if (typeof message.method === 'string') {
        const listeners = message.id === undefined ? this.notifications : this.serverRequests;
        for (const listener of listeners) {
          try {
            listener(message.method, readObjectRecord(message.params) ?? {});
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AppError(String(message.error.message || 'Codex daemon rejected the request.'), {
          code: 'CODEX_DAEMON_RPC_ERROR',
          statusCode: 409,
          details: { rpcCode: message.error.code },
        }));
      } else {
        pending.resolve(readObjectRecord(message.result) ?? {});
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new AppError(
      'The connection to Codex app was closed. Reopen the session to check whether the submitted turn completed; it was not retried.',
      { code: 'CODEX_DAEMON_DISCONNECTED', statusCode: 503 },
    )));
  }

  /**
   * An absent/stopped daemon returns null for legacy CLI-only installations.
   * An existing but incompatible daemon fails explicitly instead of inviting
   * a second process to take over one of its threads.
   */
  static async connect(options: { home?: string; timeoutMs?: number } = {}): Promise<CodexDaemonClient | null> {
    const socketPath = path.join(options.home ?? resolveCodexHomeDirectory(), 'app-server-control', 'app-server-control.sock');
    try {
      if (!(await lstat(socketPath)).isSocket()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const timeoutMs = options.timeoutMs ?? 10_000;
    // Use an ordinary HTTP Upgrade over a Unix connection. ws+unix URL
    // inference/extension negotiation is not compatible with every daemon.
    const socket = new WebSocket('ws://localhost/', {
      createConnection: () => net.createConnection({ path: socketPath }),
      perMessageDeflate: false,
      handshakeTimeout: Math.min(timeoutMs, 3_000),
    });
    const client = new CodexDaemonClient(socket, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      await client.request('initialize', {
        clientInfo: { name: 'cloudcli', title: 'Codey', version: '1' },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: 'initialized' }));
      return client;
    } catch (error) {
      client.close();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return null;
      throw error;
    }
  }

  request(method: string, params: AnyRecord): Promise<AnyRecord> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(
          `Codex app did not acknowledge ${method}. Check the session in Codex app before retrying; the request was not resubmitted.`,
          { code: 'CODEX_DAEMON_TIMEOUT', statusCode: 504 },
        ));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.fail(error);
      });
    });
  }

  onNotification(listener: (method: string, params: AnyRecord) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onServerRequest(listener: (method: string, params: AnyRecord) => void): () => void {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  close(): void {
    // Only our connection is closed. Other subscribers and their active
    // turns remain owned by the daemon.
    this.socket.terminate();
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.disconnectListeners) listener(error);
  }
}
