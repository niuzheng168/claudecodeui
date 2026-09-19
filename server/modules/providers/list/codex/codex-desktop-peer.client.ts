import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { AppError, readObjectRecord, resolveCodexHomeDirectory } from '@/shared/index.js';
import type { AnyRecord, ICodexDesktopThreadOwner } from '@/shared/index.js';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 8;

type PendingRequest = {
  resolve: (response: AnyRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Used by CodexSharedRuntime after an exact foreign-writer refusal. Desktop
 * peers coordinate over the owner's private IPC endpoint, not the app-server
 * control socket. Unlike writing a native queue, an explicit follower turn
 * reaches the owner even when a prior interruption paused queue consumption.
 *
 * Only owner discovery and one scoped turn submission are supported. This is
 * not a generic app/UI control channel. No peer is claimed as owned by Codey;
 * model, permissions, approvals and the original writer remain in the desktop.
 */
export class CodexDesktopPeerClient implements ICodexDesktopThreadOwner {
  private clientId: string | undefined;
  private ownerClientId: string | undefined;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private closedError: Error | null = null;

  private constructor(
    private readonly socket: net.Socket,
    private readonly threadId: string,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', data => {
      try { this.receive(data); }
      catch {
        this.fail(this.error('The desktop peer returned an invalid protocol frame. No alternate submission was attempted.',
          'CODEX_DESKTOP_PEER_PROTOCOL_ERROR'));
      }
    });
    socket.on('error', () => this.fail(this.disconnected()));
    socket.on('close', () => this.fail(this.disconnected()));
  }

  static async connect(
    threadId: string,
    options: {
      home?: string;
      platform?: NodeJS.Platform;
      timeoutMs?: number;
      /** Transport injection for provider contract tests; production uses the native local endpoint. */
      connectSocket?: (endpoint: string) => net.Socket;
    } = {},
  ): Promise<CodexDesktopPeerClient | null> {
    const home = options.home ?? resolveCodexHomeDirectory();
    const platform = options.platform ?? process.platform;
    const timeoutMs = options.timeoutMs ?? 8_000;
    if (!threadId || !path.isAbsolute(home) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new AppError('Invalid native desktop owner connection settings.', {
        code: 'CODEX_DESKTOP_PEER_UNAVAILABLE', statusCode: 503,
      });
    }

    let endpoint: string;
    if (platform === 'win32') {
      // Desktop's Windows pipe is user-local but not CODEX_HOME-namespaced.
      // Never use that global name for an explicitly isolated CLI profile.
      if (path.resolve(home).toLowerCase() !== path.resolve(os.homedir(), '.codex').toLowerCase()) return null;
      endpoint = '\\\\.\\pipe\\codex-ipc';
    } else {
      const directory = path.join(home, 'ipc');
      endpoint = path.join(directory, 'ipc.sock');
      try {
        const [parent, socket] = await Promise.all([lstat(directory), lstat(endpoint)]);
        const uid = process.getuid?.();
        if (uid === undefined || !parent.isDirectory() || parent.isSymbolicLink()
          || parent.uid !== uid || (parent.mode & 0o077) !== 0
          || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid) {
          throw new AppError('The desktop peer endpoint is not private to this user. No prompt was submitted.', {
            code: 'CODEX_DESKTOP_PEER_UNTRUSTED', statusCode: 503,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }

    const socket = (options.connectSocket ?? (endpoint => net.createConnection({ path: endpoint })))(endpoint);
    const client = new CodexDesktopPeerClient(socket, threadId, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(client.disconnected()), timeoutMs);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('close', () => { clearTimeout(timer); reject(client.disconnected()); });
      });
      const initialized = await client.request('initialize', 0, { clientType: 'codey' });
      if (initialized.resultType !== 'success' || initialized.method !== 'initialize'
        || typeof initialized.result?.clientId !== 'string' || !initialized.result.clientId) {
        throw client.error('The desktop peer handshake was not acknowledged.', 'CODEX_DESKTOP_PEER_PROTOCOL_ERROR');
      }
      client.clientId = initialized.result.clientId;
      const owner = await client.request('thread-owner-discovery', 1, { hostId: 'local', conversationId: threadId });
      if (owner.resultType === 'error' && owner.error === 'no-client-found') {
        client.close();
        return null;
      }
      if (owner.resultType !== 'success' || owner.method !== 'thread-owner-discovery'
        || typeof owner.handledByClientId !== 'string' || !owner.handledByClientId
        || owner.handledByClientId === client.clientId) {
        throw client.error('The owner of this desktop thread could not be verified.', 'CODEX_DESKTOP_OWNER_UNAVAILABLE');
      }
      client.ownerClientId = owner.handledByClientId;
      return client;
    } catch (error) {
      client.close();
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  }

  async startTurn(input: AnyRecord[], clientUserMessageId: string): Promise<void> {
    if (!this.ownerClientId || !clientUserMessageId || !input.length) {
      throw this.error('The desktop submission is incomplete; no prompt was sent.', 'CODEX_DESKTOP_OWNER_UNAVAILABLE');
    }
    let response: AnyRecord;
    try {
      response = await this.request('thread-follower-start-turn', 2, {
        conversationId: this.threadId,
        turnStart: {
          request: { threadId: this.threadId, clientUserMessageId, input },
          context: { inheritThreadSettings: true },
        },
      }, this.ownerClientId);
    } catch {
      throw this.unconfirmed();
    }
    if (response.resultType !== 'success' || response.method !== 'thread-follower-start-turn'
      || response.handledByClientId !== this.ownerClientId || !readObjectRecord(response.result)) {
      throw this.unconfirmed();
    }
  }

  close(): void {
    this.fail(this.disconnected());
  }

  private request(method: string, version: number, params: AnyRecord, targetClientId?: string): Promise<AnyRecord> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(this.disconnected());
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(this.error('The desktop owner did not acknowledge the request. It was not retried.',
          'CODEX_DESKTOP_PEER_TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({
          type: 'request', requestId, sourceClientId: this.clientId,
          method, version, params, targetClientId, timeoutMs: this.timeoutMs,
        });
      } catch {
        this.fail(this.error('The desktop peer request could not be encoded. No alternate submission was attempted.',
          'CODEX_DESKTOP_PEER_PROTOCOL_ERROR'));
      }
    });
  }

  private send(message: AnyRecord): void {
    const payload = Buffer.from(JSON.stringify(message));
    if (!payload.length || payload.length > MAX_FRAME_BYTES) {
      this.fail(this.error('The desktop peer request exceeds the safe frame limit.', 'CODEX_DESKTOP_PEER_PROTOCOL_ERROR'));
      return;
    }
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame, error => { if (error) this.fail(this.disconnected()); });
  }

  private receive(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) throw new Error('invalid frame length');
      if (this.buffer.length < 4 + length) return;
      const message = readObjectRecord(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(4 + length);
      if (!message) throw new Error('invalid frame');
      if (message.type === 'client-discovery-request' && typeof message.requestId === 'string') {
        // Codey is only a follower; it must never advertise ownership or handle
        // another peer's requests (including requests for unrelated threads).
        this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      } else if (message.type === 'request' && typeof message.requestId === 'string') {
        this.send({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-handler-for-request' });
      } else if (message.type === 'response' && typeof message.requestId === 'string') {
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      // No subscription is created and unrelated peer broadcasts are ignored.
    }
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }

  private disconnected(): AppError {
    return this.error('The desktop peer connection closed. No alternate runtime or submission was started.',
      'CODEX_DESKTOP_PEER_DISCONNECTED');
  }

  private unconfirmed(): AppError {
    return this.error('The desktop owner did not confirm this submission. It may already be running; check the original session before retrying. The prompt was not queued or resubmitted.',
      'CODEX_DESKTOP_SUBMISSION_UNCONFIRMED');
  }

  private error(message: string, code: string): AppError {
    return new AppError(message, { code, statusCode: 409 });
  }
}
