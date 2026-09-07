import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { projectCodexDaemonItem } from '@/modules/providers/list/codex/codex-daemon-items.js';
import { codexRuntime as sdkRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { readCodexHistoryMode } from '@/modules/providers/list/codex/codex-thread-storage.repository.js';
import { appendFilesInputTag, buildCodexInputItems } from '@/shared/image-attachments.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import {
  AppError, createCompleteMessage, createNormalizedMessage, readObjectRecord,
} from '@/shared/utils.js';

type SharedRun = {
  client: CodexDaemonClient | null;
  threadId: string | null;
  turnId: string | null;
  aborted: boolean;
};

function describeResumeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/already has an active writer|thread-store conflict/i.test(message)) {
    return 'This session is owned by another Codex process. Continue through the owning Codex app daemon, or wait for the other process to release it. No writer lock was removed and the prompt was not retried.';
  }
  return message;
}

function send(writer: ProviderRuntimeWriter, message: unknown): void {
  try {
    writer.send(writer.isSSEStreamWriter || writer.isWebSocketWriter ? message : JSON.stringify(message));
  } catch (error) {
    // Match the SDK writer's behavior: a disconnected browser must not throw
    // out of a progress timer or kill work still owned by the Codex daemon.
    console.warn('[Codex] Cannot forward daemon output:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Used by CodexProvider to create and continue threads through the existing
 * desktop owner. Only legacy installations without a daemon retain the SDK
 * adapter. Once a daemon request is attempted, there is no exec fallback.
 */
export class CodexSharedRuntime implements IProviderRuntime {
  private readonly runs = new Map<string, SharedRun>();

  constructor(private readonly fallback: IProviderRuntime = sdkRuntime) {}

  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
    const threadId = context.resolveProviderSessionId(sessionId);
    if (!sessionId) {
      await this.fallback.run(command, options, writer, context);
      return;
    }
    if (this.runs.has(sessionId)) {
      send(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'error', content: 'This session already has a Codey run in progress.',
      }));
      send(writer, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
      return;
    }

    const run: SharedRun = { client: null, threadId, turnId: null, aborted: false };
    this.runs.set(sessionId, run);
    try {
      run.client = await CodexDaemonClient.connect();
      if (run.aborted) return;
      if (!run.client) {
        const historyMode = threadId ? await readCodexHistoryMode(threadId) : null;
        if (historyMode && historyMode !== 'legacy') {
          throw new AppError('This desktop session uses paginated history. Keep its Codex app daemon available to continue it in Codey; it cannot safely be resumed by the bundled exec SDK.', {
            code: 'CODEX_DAEMON_REQUIRED', statusCode: 409,
          });
        }
        // Keep legacy installations working, but make an exec writer conflict
        // actionable. Merely finding a .lock file is NOT proof of a live lock.
        await this.fallback.run(command, options, {
          ...writer,
          send: (data) => {
            let record: AnyRecord | null = null;
            try { record = readObjectRecord(typeof data === 'string' ? JSON.parse(data) : data); } catch { /* Preserve non-JSON output. */ }
            if (record?.kind === 'error' && typeof record.content === 'string') {
              const updated = { ...record, content: describeResumeError(new Error(record.content)) };
              writer.send(typeof data === 'string' ? JSON.stringify(updated) : updated);
            } else {
              writer.send(data);
            }
          },
        }, context);
        return;
      }

      await this.runThroughDaemon(run, command, options, writer, context);
    } catch (error) {
      if (!run.aborted) {
        send(writer, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'error', content: describeResumeError(error),
        }));
        send(writer, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
        // The legacy JS notifier infers sessionId from its null default even
        // though the runtime contract accepts provider/app session strings.
        (notifyRunFailed as (input: AnyRecord) => void)({
          userId: writer.userId ?? null, provider: 'codex', sessionId,
          sessionName: options.sessionSummary, error,
        });
      }
    } finally {
      run.client?.close();
      this.runs.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<boolean> {
    const run = this.runs.get(sessionId);
    if (!run || !run.client) {
      const stopped = await this.fallback.abort(sessionId);
      if (run) run.aborted = true;
      return stopped || Boolean(run);
    }
    // Never interrupt a desktop turn merely because it shares the thread id.
    if (run.turnId) {
      await run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
    }
    run.aborted = true;
    return true;
  }

  private async runThroughDaemon(
    run: SharedRun,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> {
    const client = run.client!;
    const sessionId = String(options.sessionId);
    const model = await context.resolveResumeModel(sessionId, options.model);
    const workingDirectory = options.cwd || options.projectPath || process.cwd();
    const input = buildCodexInputItems(
      appendFilesInputTag(command, options.files), options.images, workingDirectory,
    ).map((item) => item.type === 'local_image' ? { type: 'localImage', path: item.path } : item);
    const catalog = await context.getProviderModels();
    const allowedEfforts = catalog.OPTIONS.find((option) => option.value === model)
      ?.effort?.values?.map((value) => value.value) ?? [];
    const effort = typeof options.effort === 'string' && options.effort !== 'default'
      && allowedEfforts.includes(options.effort) ? options.effort : undefined;
    if (run.aborted) return;

    const permissionMode = options.permissionMode;
    const fullAccessSelected = permissionMode === 'bypassPermissions';
    const approvalPolicy = fullAccessSelected || permissionMode === 'acceptEdits' ? 'never' : 'untrusted';
    // The composer sends its selection with every message, including resumes.
    // An omitted mode still inherits the thread's permissions; it must not
    // silently enable full access or reset a desktop user's custom policy.
    const turnPermissions = permissionMode === 'default' || permissionMode === 'acceptEdits' || fullAccessSelected
      ? {
        approvalPolicy,
        sandboxPolicy: { type: fullAccessSelected ? 'dangerFullAccess' : 'workspaceWrite' },
      }
      : {};

    if (!run.threadId) {
      // Creating with exec would make source=exec, hidden from the App's
      // default thread/list. Let the shared daemon choose its own source;
      // never spoof client identity or rewrite an existing thread's metadata.
      const created = await client.request('thread/start', {
        cwd: workingDirectory,
        ...(model ? { model } : {}),
        // ThreadStartParams uses CLI-style enum strings, unlike the
        // camelCase tagged SandboxPolicy returned by the daemon.
        sandbox: fullAccessSelected ? 'danger-full-access' : 'workspace-write',
        approvalPolicy,
      });
      if (typeof created.thread?.id !== 'string' || !created.thread.id) {
        throw new Error('Codex did not acknowledge the new thread id. No prompt was submitted; check Codex app before retrying.');
      }
      const createdThreadId: string = created.thread.id;
      run.threadId = createdThreadId;
      // Persist the app/native mapping even if cancelled while thread/start
      // was pending, so a later send continues this thread instead of forking.
      writer.setSessionId?.(createdThreadId);
      send(writer, createNormalizedMessage({
        provider: 'codex', kind: 'session_created', sessionId: createdThreadId, newSessionId: createdThreadId,
      }));
    } else {
      // Attach without changing permissions: the thread may still have an
      // active desktop turn. Apply Codey's selection only at turn/start,
      // after the busy check, alongside the user's model/effort selection.
      const resumed = await client.request('thread/resume', { threadId: run.threadId, excludeTurns: true });
      if (resumed.thread?.id !== run.threadId) {
        throw new Error('Codex did not attach the requested thread. No prompt was submitted.');
      }
      if (resumed.thread?.status?.type === 'active') {
        throw new AppError('This session is currently running in Codex app. Wait for that turn to finish before sending another message from Codey.', {
          code: 'CODEX_THREAD_BUSY', statusCode: 409,
        });
      }
    }
    if (run.aborted) return;

    const items = new Map<string, AnyRecord>();
    const dirtyItems = new Map<string, AnyRecord>();
    const earlyEvents: Array<[string, AnyRecord]> = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn!: (turn: AnyRecord) => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<AnyRecord>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // A disconnect can precede the turn/start response. Consume that rejection
    // even if request() fails before control reaches await completed.
    void completed.catch(() => {});

    const emitItem = (item: AnyRecord) => {
      if (item.type === 'userMessage') return; // The gateway already emitted the submitted prompt.
      for (const raw of projectCodexDaemonItem(item, run.turnId ?? '', new Date().toISOString())) {
        for (const message of context.normalizeMessage(raw, run.threadId)) send(writer, message);
      }
    };
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      for (const item of dirtyItems.values()) emitItem(item);
      dirtyItems.clear();
    };
    const queueItem = (item: AnyRecord) => {
      dirtyItems.set(item.id, item);
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    };
    const handleEvent = (method: string, params: AnyRecord) => {
      if (params.threadId !== run.threadId) return;
      if (!run.turnId) {
        if (earlyEvents.length >= 1_000) {
          rejectTurn(new Error('Codex sent too many events before acknowledging the turn. Check the session in Codex app before retrying.'));
        } else {
          earlyEvents.push([method, params]);
        }
        return;
      }
      const eventTurnId = params.turnId ?? params.turn?.id;
      if (eventTurnId && eventTurnId !== run.turnId) return;
      if (method === 'item/started' || method === 'item/completed') {
        const item = readObjectRecord(params.item);
        if (!item || typeof item.id !== 'string') return;
        items.set(item.id, item);
        dirtyItems.delete(item.id);
        emitItem(item);
      } else if (method === 'item/agentMessage/delta') {
        const item = items.get(params.itemId) ?? { id: params.itemId, type: 'agentMessage', text: '' };
        item.text = String(item.text || '') + String(params.delta || '');
        items.set(item.id, item);
        queueItem(item);
      } else if (method === 'item/commandExecution/outputDelta') {
        const item = items.get(params.itemId);
        if (item) {
          item.aggregatedOutput = String(item.aggregatedOutput || '') + String(params.delta || '');
          queueItem(item);
        }
      } else if (method === 'turn/plan/updated') {
        for (const message of context.normalizeMessage({
          type: 'item', itemType: 'todo_list', itemId: `plan_${run.turnId}`,
          items: (Array.isArray(params.plan) ? params.plan : []).map((step: AnyRecord) => ({
            text: step.step, completed: step.status === 'completed',
          })),
        }, run.threadId)) send(writer, message);
      } else if (method === 'turn/completed') {
        flush();
        resolveTurn(readObjectRecord(params.turn) ?? {});
      }
    };
    const offEvent = client.onNotification(handleEvent);
    const offDisconnect = client.onDisconnect(rejectTurn);
    const offRequest = client.onServerRequest((method, params) => {
      if (params.threadId !== run.threadId) return;
      // Desktop-specific tools and approvals stay with the desktop client.
      // Answering/declining them here could resolve another client's request.
      send(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'task_notification', status: 'info',
        summary: `Codex app requires an interaction (${method}). Answer it in Codex app to continue; Codey has not approved or declined it.`,
      }));
    });

    try {
      if (run.aborted) return;
      const response = await client.request('turn/start', {
        threadId: run.threadId, input,
        ...turnPermissions,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      if (typeof response.turn?.id !== 'string') {
        throw new Error('Codex did not acknowledge a turn id. Check Codex app before retrying; no exec fallback was started.');
      }
      run.turnId = response.turn.id;
      for (const [method, params] of earlyEvents) handleEvent(method, params);
      earlyEvents.length = 0;
      if (run.aborted) {
        await client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
      }
      const turn = await completed;
      if (run.aborted) return;
      if (turn.status === 'failed') throw new Error(turn.error?.message || 'Codex turn failed.');
      send(writer, createCompleteMessage({
        provider: 'codex', sessionId, actualSessionId: run.threadId,
        exitCode: turn.status === 'completed' ? 0 : 1,
        aborted: turn.status === 'interrupted',
      }));
      if (turn.status === 'completed') {
        (notifyRunStopped as (input: AnyRecord) => void)({
          userId: writer.userId ?? null, provider: 'codex', sessionId,
          sessionName: options.sessionSummary, stopReason: 'completed',
        });
      }
    } finally {
      offEvent();
      offDisconnect();
      offRequest();
      if (flushTimer) clearTimeout(flushTimer);
    }
  }
}

/** Consumed by CodexProvider; keeps the existing SDK adapter as a legacy fallback. */
export const codexSharedRuntime = new CodexSharedRuntime();
