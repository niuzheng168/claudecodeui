import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  AppError, readObjectRecord, resolveCodexHomeDirectory,
} from '@/shared/index.js';
import type {
  AnyRecord, CodexRpcRequestId, CodexRpcServerReply, ICodexRpcClient,
} from '@/shared/index.js';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;

type Pending = {
  resolve(value: AnyRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Used by CodexSharedRuntime on configured Windows nodes and for native
 * goal/plan operations on CLI-only nodes. The
 * reviewed native CLI reads the real history format; no exec/JSONL fallback,
 * extra listener, desktop-process takeover, or retry of a submitted turn.
 * One connection owns one child and awaits its exit to release writer locks.
 */
export class CodexStdioClient implements ICodexRpcClient {
  readonly ownsProcess = true;
  private nextId = 0;
  private buffered = '';
  private closedError: Error | null = null;
  private childExited = false;
  private childClosed = false;
  private closing: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Set<(method: string, params: AnyRecord) => void>();
  private readonly serverRequests = new Set<(method: string, params: AnyRecord, id?: CodexRpcRequestId) => void>();
  private readonly serverPending = new Set<CodexRpcRequestId>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffered += chunk;
      if (Buffer.byteLength(this.buffered, 'utf8') > MAX_FRAME_BYTES) {
        this.fail(new AppError('The native Codex response exceeded the safe frame limit.', {
          code: 'CODEX_STDIO_PROTOCOL_ERROR', statusCode: 502,
        }));
        void this.close().catch(() => {});
        return;
      }
      let newline: number;
      while ((newline = this.buffered.indexOf('\n')) >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        try { this.receive(line); }
        catch {
          this.fail(new AppError('The native Codex event could not be processed.', {
            code: 'CODEX_STDIO_PROTOCOL_ERROR', statusCode: 502,
          }));
          void this.close().catch(() => {});
        }
      }
    });
    // Drain logs without persisting provider details, prompts, credentials or stderr.
    child.stderr.resume();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', () => this.fail(this.disconnected()));
    }
    child.on('error', () => this.fail(new AppError('The configured native Codex process could not start.', {
      code: 'CODEX_STDIO_UNAVAILABLE', statusCode: 503,
    })));
    child.once('exit', () => {
      this.childExited = true;
      this.fail(this.disconnected());
    });
    child.once('close', () => {
      this.childClosed = true;
      this.fail(this.disconnected());
    });
  }

  static async connect(
    options: { executable?: string; launcherArgs?: string[]; home?: string; timeoutMs?: number } = {},
  ): Promise<CodexStdioClient> {
    const executable = options.executable ?? process.env.CODEY_CODEX_EXECUTABLE;
    const home = options.home ?? resolveCodexHomeDirectory();
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!executable || !path.isAbsolute(executable) || !path.isAbsolute(home)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new AppError('Configure an absolute native Codex executable and home for the native runtime.', {
        code: 'CODEX_STDIO_UNAVAILABLE', statusCode: 503,
      });
    }
    try {
      if (!(await stat(executable)).isFile()) throw new Error('missing');
    } catch {
      throw new AppError('The configured native Codex executable is unavailable; no PATH fallback was started.', {
        code: 'CODEX_STDIO_UNAVAILABLE', statusCode: 503,
      });
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !['CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']
        .includes(name.toUpperCase())));
    const child = spawn(executable, [...(options.launcherArgs ?? []), 'app-server', '--stdio'], {
      cwd: home, env: { ...env, CODEX_HOME: home }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new CodexStdioClient(child, timeoutMs);
    try {
      await client.request('initialize', {
        clientInfo: { name: 'cloudcli', title: 'Codey', version: '1' },
        capabilities: { experimentalApi: true },
      });
      client.write({ method: 'initialized', params: {} });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /**
   * Used by the native command runtime only after the existing-owner check.
   * Managed packages use their configured CLI; source installs can use the
   * packaged launcher. Never chooses a different executable after an RPC fails.
   */
  static async connectInstalled(): Promise<CodexStdioClient> {
    if (process.env.CODEY_CODEX_EXECUTABLE) return this.connect();
    let launcher: string;
    try {
      launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    } catch {
      throw new AppError('Native /goal and /plan require a configured Codex CLI. Update the node or configure CODEY_CODEX_EXECUTABLE.', {
        code: 'CODEX_STDIO_UNAVAILABLE', statusCode: 503,
      });
    }
    return this.connect({ executable: process.execPath, launcherArgs: [launcher] });
  }

  request(method: string, params: AnyRecord): Promise<AnyRecord> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.closing) return Promise.reject(this.disconnected());
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new AppError('Too many pending native Codex requests.', {
        code: 'CODEX_STDIO_BUSY', statusCode: 503,
      }));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(`Native Codex did not acknowledge ${method}; the request was not retried.`, {
          code: 'CODEX_STDIO_TIMEOUT', statusCode: 504,
        }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  onNotification(listener: (method: string, params: AnyRecord) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onServerRequest(listener: (method: string, params: AnyRecord, id?: CodexRpcRequestId) => void): () => void {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    if (this.closedError) listener(this.closedError);
    return () => this.disconnectListeners.delete(listener);
  }

  respondToServerRequest(id: CodexRpcRequestId, reply: CodexRpcServerReply): void {
    if (this.closedError || !this.serverPending.delete(id)) return;
    this.write({ id, ...reply });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise((resolve, reject) => {
      // On Windows a helper can inherit a stdio handle after its app-server
      // parent exits. The native writer is released on process exit, not when
      // every inherited pipe closes. Never wait for or terminate other helpers.
      const releaseStreams = () => {
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      };
      if (this.childExited || this.childClosed) { releaseStreams(); resolve(); return; }
      const force = setTimeout(() => { this.child.kill(); }, 2000);
      const deadline = setTimeout(() => {
        this.child.off('exit', finished);
        this.child.off('close', finished);
        reject(new AppError('The owned native Codex process has not exited; do not start a competing writer.', {
          code: 'CODEX_STDIO_CLOSE_TIMEOUT', statusCode: 503,
        }));
      }, 5000);
      const finished = () => {
        clearTimeout(force);
        clearTimeout(deadline);
        this.child.off('exit', finished);
        this.child.off('close', finished);
        releaseStreams();
        resolve();
      };
      this.child.once('exit', finished);
      this.child.once('close', finished);
      this.child.stdin.end();
    });
    return this.closing;
  }

  private write(message: AnyRecord): void {
    if (this.closedError) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.fail(this.disconnected());
    });
  }

  private receive(line: string): void {
    let message: AnyRecord | null;
    try { message = readObjectRecord(JSON.parse(line)); } catch { return; }
    if (!message) return;
    if (typeof message.method === 'string') {
      const params = readObjectRecord(message.params) ?? {};
      if (message.id !== undefined) {
        if (message.method.length > 256 || this.serverPending.size >= MAX_PENDING_REQUESTS
          || (!Number.isSafeInteger(message.id) && typeof message.id !== 'string')
          || String(message.id).length > 256 || this.serverPending.has(message.id)) {
          this.fail(this.disconnected());
          return;
        }
        this.serverPending.add(message.id);
        for (const listener of this.serverRequests) listener(message.method, params, message.id);
      } else {
        for (const listener of this.notifications) listener(message.method, params);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new AppError(String(message.error.message || 'Native Codex rejected the request.').slice(0, 2000), {
        code: 'CODEX_STDIO_RPC_ERROR', statusCode: 409,
        details: { rpcCode: message.error.code },
      }));
    } else {
      pending.resolve(readObjectRecord(message.result) ?? {});
    }
  }

  private disconnected(): AppError {
    return new AppError('The native Codex connection closed. Check the session before retrying; no turn was resubmitted.', {
      code: 'CODEX_STDIO_DISCONNECTED', statusCode: 503,
    });
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.serverPending.clear();
    for (const listener of this.disconnectListeners) {
      try { listener(error); } catch { /* A failed consumer cannot crash the Workspace. */ }
    }
  }
}
