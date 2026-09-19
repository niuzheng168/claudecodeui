import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { connectCodexNativeClient } from '@/modules/providers/list/codex/codex-native-client.service.js';
import { CodexDesktopPeerClient } from '@/modules/providers/list/codex/codex-desktop-peer.client.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { CodexStdioPermissions } from '@/modules/providers/list/codex/codex-stdio-permissions.service.js';
import { CodexNativeQueueRun } from '@/modules/providers/list/codex/codex-native-queue.service.js';
import { CodexGoalRun } from '@/modules/providers/list/codex/codex-goal-run.service.js';
import { controlCodexGoal, formatCodexGoalResult, getCodexGoal, parseCodexGoalCommand } from '@/modules/providers/list/codex/codex-goal.service.js';
import { projectCodexDaemonItem } from '@/modules/providers/list/codex/codex-daemon-items.js';
import { codexRuntime as sdkRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { assertCodexDesktopSelection, readCodexHistoryMode } from '@/modules/providers/list/codex/codex-thread-storage.repository.js';
import type { CodexGoal, CodexGoalCommand, ICodexDesktopThreadOwner, ICodexRpcClient, IProviderRuntime, AnyRecord, ProviderAbortOptions, ProviderRuntimeContext, ProviderRuntimeObservation, ProviderRuntimeWriter } from '@/shared/index.js';
import {
  AppError, createCompleteMessage, createNormalizedMessage, readObjectRecord,
  appendFilesInputTag, buildCodexInputItems,
} from '@/shared/index.js';

type SharedRun = {
  client: ICodexRpcClient | null;
  threadId: string | null;
  turnId: string | null;
  aborted: boolean;
  finished: boolean;
  workingDirectory: string;
  /** Native Stop waits for an owned writer to be released before the gateway admits another run. */
  released: Promise<void>;
  desktopQueue?: CodexNativeQueueRun;
  /** Attaching/steering does not transfer ownership of the desktop's active turn. */
  observesDesktopTurn?: boolean;
  goal?: CodexGoalRun;
  localNative?: boolean;
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

function nativeInputIdentity(value: unknown): { clientUserMessageId?: string } {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? { clientUserMessageId: value } : {};
}

async function steerCodexTurn(
  client: ICodexRpcClient, threadId: string, expectedTurnId: string, input: AnyRecord[], clientMessageId?: unknown,
): Promise<void> {
  // Never redirect a stale correction into a newer turn or retry an ambiguous acknowledgement.
  const result = await client.request('turn/steer', {
    threadId, expectedTurnId, input, ...nativeInputIdentity(clientMessageId),
  });
  if (result.turnId !== expectedTurnId) {
    throw new AppError('Codex did not acknowledge the expected turn. Check the transcript before retrying; the instruction was not resubmitted.', {
      code: 'STEER_UNCONFIRMED', statusCode: 409,
    });
  }
}

async function readActiveDesktopTurn(
  client: ICodexRpcClient, threadId: string, snapshot?: AnyRecord,
): Promise<AnyRecord> {
  snapshot ??= await client.request('thread/read', { threadId, includeTurns: false });
  // Paginated threads require the native turns API. Never pick an old
  // unfinished turn, infer activity from a lock, or follow a different thread.
  const page = await client.request('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
  });
  const turns = Array.isArray(page.data) ? page.data : [];
  if (snapshot.thread?.id !== threadId || snapshot.thread?.status?.type !== 'active'
    || turns.length !== 1 || turns[0]?.status !== 'inProgress'
    || typeof turns[0].id !== 'string' || !turns[0].id || turns[0].completedAt != null) {
    throw new AppError('The active Codex turn changed or could not be verified. No message was submitted; refresh the session before sending again.', {
      code: 'CODEX_ACTIVE_TURN_UNCONFIRMED', statusCode: 409,
    });
  }
  return turns[0];
}

/**
 * Used by CodexProvider to run through the existing owner, or the configured
 * native stdio runtime on any platform. Writer conflicts fail closed; no desktop
 * process or lock is stopped/removed. Once native RPC is selected, there is no exec fallback.
 */
export class CodexSharedRuntime implements IProviderRuntime {
  private readonly runs = new Map<string, SharedRun>();
  private readonly ownedPermissions = new CodexStdioPermissions();
  readonly permissions = this.ownedPermissions.gateway;

  constructor(
    private readonly fallback: IProviderRuntime = sdkRuntime,
    private readonly connect: () => Promise<ICodexRpcClient | null> = connectCodexNativeClient,
    private readonly connectLocalNative: () => Promise<ICodexRpcClient> = () => CodexStdioClient.connectInstalled(),
    private readonly connectDesktopOwner: (threadId: string) => Promise<ICodexDesktopThreadOwner | null>
      = threadId => CodexDesktopPeerClient.connect(threadId),
  ) {}

  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    return this.executeRun(command, options, writer, context);
  }

  async prepareObservation(sessionId: string, context: ProviderRuntimeContext): Promise<ProviderRuntimeObservation | null> {
    const threadId = context.resolveProviderSessionId(sessionId);
    if (!threadId || this.runs.has(sessionId) || process.env.CODEY_CODEX_RUNTIME_TRANSPORT === 'stdio') return null;
    const client = await this.connect();
    if (!client) return null;
    let prepared = false;
    try {
      // A private stdio child cannot control another process's desktop turn.
      if (client.ownsProcess) return null;
      const snapshot = await client.request('thread/read', { threadId, includeTurns: false });
      if (snapshot.thread?.id !== threadId || snapshot.thread?.status?.type !== 'active') return null;
      const turn = await readActiveDesktopTurn(client, threadId, snapshot);
      let started = false;
      prepared = true;
      return {
        start: async (writer) => {
          if (started) throw new Error('This Codex observer has already been attached.');
          started = true;
          await this.executeRun('', { sessionId, cwd: snapshot.thread.cwd }, writer, context, {
            client, threadId, turnId: turn.id,
          });
        },
        dispose: () => client.close(),
      };
    } finally {
      if (!prepared) await client.close();
    }
  }

  private async executeRun(
    command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext,
    observation?: { client: ICodexRpcClient; threadId: string; turnId: string },
  ): Promise<void> {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
    const threadId = context.resolveProviderSessionId(sessionId);
    if (!sessionId) {
      if (/^\/(?:goal|plan)(?:\s|$)/.test(command) || options.permissionMode === 'plan' || options.codexPlanMode === true) {
        throw new AppError('Native commands require a Codey session id. Create the session before sending.', {
          code: 'NATIVE_COMMAND_SESSION_REQUIRED', statusCode: 400,
        });
      }
      await this.fallback.run(command, options, writer, context);
      return;
    }
    if (this.runs.has(sessionId)) {
      await observation?.client.close();
      send(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'error', content: 'This session already has a Codey run in progress.',
      }));
      send(writer, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
      return;
    }

    let markReleased!: () => void;
    const released = new Promise<void>((resolve) => { markReleased = resolve; });
    const run: SharedRun = {
      client: null, threadId, turnId: null, aborted: false, finished: false,
      observesDesktopTurn: Boolean(observation),
      workingDirectory: options.cwd || options.projectPath || process.cwd(),
      released,
    };
    this.runs.set(sessionId, run);
    let deferredComplete: AnyRecord | null = null;
    const output: ProviderRuntimeWriter = {
      userId: writer.userId, isSSEStreamWriter: writer.isSSEStreamWriter,
      isWebSocketWriter: writer.isWebSocketWriter, setSessionId: writer.setSessionId?.bind(writer),
      send: (value) => {
        let record: AnyRecord | null = null;
        try { record = readObjectRecord(typeof value === 'string' ? JSON.parse(value) : value); } catch { /* Forward non-JSON unchanged. */ }
        if (run.client && record?.kind === 'complete') deferredComplete = record;
        else writer.send(value);
      },
    };
    try {
      const goalMatch = command.match(/^\/goal(?:\s+([\s\S]*))?$/);
      const goalCommand = goalMatch ? parseCodexGoalCommand(goalMatch[1] ?? '') : undefined;
      const planMatch = command.match(/^\/plan(?:\s+([\s\S]*))?$/);
      if (planMatch) {
        const prompt = planMatch[1]?.trim();
        if (!prompt || prompt === 'on' || prompt === 'off') {
          throw new AppError('Use /plan in the updated Codey composer to switch modes, or /plan <prompt> to start planning.', {
            code: 'PLAN_PROMPT_REQUIRED', statusCode: 400,
          });
        }
        command = prompt;
        options = { ...options, permissionMode: 'plan', codexPlanMode: true };
      }
      if (goalCommand && (options.permissionMode === 'plan' || options.codexPlanMode === true)
        && (goalCommand.action === 'set' || goalCommand.action === 'resume')) {
        throw new AppError('Leave Plan Mode with /plan off before starting or resuming an autonomous goal.', {
          code: 'GOAL_IN_PLAN_MODE', statusCode: 409,
        });
      }
      if (goalCommand && (options.images?.length || options.files?.length)) {
        throw new AppError('Goal commands do not accept attachments. Refer to a project file in the objective instead.', {
          code: 'GOAL_ATTACHMENTS_UNSUPPORTED', statusCode: 400,
        });
      }
      if (goalCommand && goalCommand.action !== 'set' && goalCommand.action !== 'resume') {
        const goal = run.threadId ? await this.controlGoal(sessionId, run.threadId, goalCommand, true) : null;
        send(output, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'text', role: 'assistant',
          content: formatCodexGoalResult(goal, goalCommand).message,
        }));
        send(output, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0 }));
        return;
      }
      run.client = observation?.client ?? await this.connect();
      if (observation && threadId !== observation.threadId) {
        throw new AppError('The session mapping changed before observation. No turn was started.', {
          code: 'CODEX_OBSERVATION_EXPIRED', statusCode: 409,
        });
      }
      if (run.aborted) return;
      if (!run.client) {
        const historyMode = threadId ? await readCodexHistoryMode(threadId) : null;
        if (historyMode && historyMode !== 'legacy') {
          throw new AppError('This desktop session uses paginated history. Connect its Codex app backend or configure CODEY_CODEX_EXECUTABLE to continue it with the native runtime; it cannot safely be resumed by the exec SDK.', {
            code: 'CODEX_DAEMON_REQUIRED', statusCode: 409,
          });
        }
        // An explicit default mode must also reach native RPC: exec cannot
        // acknowledge leaving a previously selected collaboration mode.
        if (goalCommand || options.permissionMode === 'plan' || typeof options.codexPlanMode === 'boolean') {
          run.client = await this.connectLocalNative();
          run.localNative = true;
        }
      }
      if (!run.client) {
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

      await this.runThroughDaemon(run, command, options, output, context, goalCommand, observation?.turnId);
    } catch (error) {
      if (!run.aborted) {
        send(output, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'error', content: describeResumeError(error),
        }));
        send(output, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
        // The legacy JS notifier infers sessionId from its null default even
        // though the runtime contract accepts provider/app session strings.
        (notifyRunFailed as (input: AnyRecord) => void)({
          userId: writer.userId ?? null, provider: 'codex', sessionId,
          sessionName: options.sessionSummary, error,
        });
      }
    } finally {
      run.finished = true;
      if (run.client) this.ownedPermissions.cancel(sessionId, run.client);
      try {
        // Release this runtime slot/connection before the browser sees
        // completion and submits a queued message against the same thread.
        await run.client?.close();
      } catch {
        send(writer, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'error',
          content: 'The native Codex process has not released its writer yet. Wait before retrying this session.',
        }));
        deferredComplete = createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 });
      } finally {
        if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
      }
      if (deferredComplete) send(writer, deferredComplete);
      markReleased();
    }
  }

  /** Used by the providers command service; controls the owning connection without taking over another run. */
  async controlGoal(
    sessionId: string, threadId: string, command: CodexGoalCommand, fromRun = false,
  ): Promise<CodexGoal | null> {
    const run = this.runs.get(sessionId);
    if (run?.goal) return run.goal.control(command);
    if (run?.client && run.threadId === threadId && !run.finished) {
      return controlCodexGoal(run.client, threadId, command);
    }
    if (run && !fromRun) {
      throw new AppError('This session is starting or finishing a run. Try /goal again after its status changes.', {
        code: 'GOAL_RUN_BUSY', statusCode: 409,
      });
    }
    let client = await this.connect();
    if (!client) {
      const historyMode = await readCodexHistoryMode(threadId);
      if (historyMode && historyMode !== 'legacy') {
        throw new AppError('Keep the owning Codex app daemon available to manage this native session goal.', {
          code: 'CODEX_DAEMON_REQUIRED', statusCode: 409,
        });
      }
      client = await this.connectLocalNative();
    }
    try {
      // In particular, never thread/resume for a read or pause/clear command.
      return await controlCodexGoal(client, threadId, command);
    } finally {
      await client.close();
    }
  }

  async abort(sessionId: string, options: ProviderAbortOptions = {}): Promise<boolean> {
    const run = this.runs.get(sessionId);
    if (run?.observesDesktopTurn && (!options.allowExternalTurn || !run.turnId)) {
      // Only a Stop explicitly bound to this attached run may interrupt it.
      // Scheduling, disconnects and cleanup do not take ownership of a turn.
      throw new AppError('Stopping a desktop turn requires an explicit Stop from the updated Codey session after attachment finishes. The turn is still running.', {
        code: 'CODEX_DESKTOP_TURN_NOT_OWNED', statusCode: 409,
      });
    }
    if (run?.finished || run?.aborted) return false;
    if (run?.goal) {
      await run.goal.abort();
      run.aborted = true;
      if (run.client?.ownsProcess) await run.released;
      return true;
    }
    if (run?.desktopQueue) {
      const cancelled = await run.desktopQueue.cancel();
      if (cancelled) run.aborted = true;
      return cancelled;
    }
    if (!run || !run.client) {
      const stopped = await this.fallback.abort(sessionId);
      if (run) run.aborted = true;
      return stopped || Boolean(run);
    }
    // Address only the captured turn, never whichever turn is now on the thread.
    if (run.turnId) {
      await run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
    }
    run.aborted = true;
    if (run.client.ownsProcess || run.observesDesktopTurn) await run.released;
    return true;
  }

  canInterrupt(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    return Boolean(run && !run.aborted && !run.finished
      && (!run.observesDesktopTurn || run.turnId)
      && (!run.desktopQueue || !run.turnId));
  }

  canSteer(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    return Boolean(run?.client && !run.desktopQueue && run.threadId && run.turnId && !run.aborted && !run.finished);
  }

  async steer(sessionId: string, command: string, options: AnyRecord): Promise<void> {
    if (/^\/(?:goal|plan)(?:\s|$)/.test(command)) {
      throw new AppError('Native commands must use the composer command entry, not an in-flight correction.', {
        code: 'STEER_COMMAND_UNSUPPORTED', statusCode: 409,
      });
    }
    // Capture the tracked turn before any async work. A completion/new run must
    // never redirect this prompt into another turn or another desktop client.
    const run = this.runs.get(sessionId);
    if (!run?.client || run.desktopQueue || !run.threadId || !run.turnId || run.aborted || run.finished) {
      throw new AppError('This turn cannot be steered now. Keep the draft or queue it for the next turn.', {
        code: 'STEER_UNAVAILABLE', statusCode: 409,
      });
    }
    const expectedTurnId = run.turnId;
    const input = buildCodexInputItems(
      appendFilesInputTag(command, options.files), options.images, run.workingDirectory,
    ).map((item) => item.type === 'local_image' ? { type: 'localImage', path: item.path } : item);

    // Model, effort, permissions, cwd and thread selection belong to turn/start,
    // not an in-flight correction. Never retry a rejected/ambiguous steer.
    await steerCodexTurn(run.client, run.threadId, expectedTurnId, input, options.clientMessageId);
  }

  private async runThroughDaemon(
    run: SharedRun,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
    goalCommand?: CodexGoalCommand,
    observedTurnId?: string,
  ): Promise<void> {
    const client = run.client!;
    const sessionId = String(options.sessionId);
    const model = observedTurnId ? undefined : await context.resolveResumeModel(sessionId, options.model);
    const workingDirectory = run.workingDirectory;
    const input = buildCodexInputItems(
      appendFilesInputTag(command, options.files), options.images, workingDirectory,
    ).map((item) => item.type === 'local_image' ? { type: 'localImage', path: item.path } : item);
    const catalog = observedTurnId ? { DEFAULT: '', OPTIONS: [] } : await context.getProviderModels();
    const allowedEfforts = catalog.OPTIONS.find((option) => option.value === model)
      ?.effort?.values?.map((value) => value.value) ?? [];
    const effort = typeof options.effort === 'string' && options.effort !== 'default'
      && allowedEfforts.includes(options.effort) ? options.effort : undefined;
    if (run.aborted) return;

    const permissionMode = options.permissionMode;
    const planMode = permissionMode === 'plan' || options.codexPlanMode === true;
    const fullAccessSelected = permissionMode === 'bypassPermissions';
    const approvalPolicy = fullAccessSelected || permissionMode === 'acceptEdits' ? 'never' : 'untrusted';
    // The composer sends its selection with every message, including resumes.
    // An omitted mode still inherits the thread's permissions; it must not
    // silently enable full access or reset a desktop user's custom policy.
    const turnPermissions = permissionMode === 'default' || permissionMode === 'acceptEdits' || fullAccessSelected || planMode
      ? {
        approvalPolicy,
        sandboxPolicy: { type: planMode ? 'readOnly' : fullAccessSelected ? 'dangerFullAccess' : 'workspaceWrite' },
      }
      : {};
    const turnSettings = {
      ...turnPermissions,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(planMode || options.codexPlanMode === false || goalCommand ? {
        collaborationMode: {
          mode: planMode ? 'plan' : 'default',
          settings: {
            model: model || catalog.DEFAULT, reasoning_effort: effort ?? null,
            // null selects Codex's built-in mode instructions, not a lookalike prompt.
            developer_instructions: null,
          },
        },
      } : {}),
    };
    let activeDesktopTurn: AnyRecord | null = null;

    if (!run.threadId) {
      // Creating with exec would make source=exec, hidden from the App's
      // default thread/list. Let the shared daemon choose its own source;
      // never spoof client identity or rewrite an existing thread's metadata.
      const created = await client.request('thread/start', {
        cwd: workingDirectory,
        ...(model ? { model } : {}),
        // ThreadStartParams uses CLI-style enum strings, unlike the
        // camelCase tagged SandboxPolicy returned by the daemon.
        sandbox: planMode ? 'read-only' : fullAccessSelected ? 'danger-full-access' : 'workspace-write',
        approvalPolicy,
        // CLI-only native commands retain the legacy transcript contract, so
        // later ordinary exec turns remain resumable. Never convert a desktop thread.
        ...(run.localNative ? { historyMode: 'legacy' } : {}),
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
      if (goalCommand || (client.ownsProcess && (planMode || typeof options.codexPlanMode === 'boolean'))) {
        let existingGoal: CodexGoal | null = null;
        try {
          existingGoal = await getCodexGoal(client, run.threadId);
        } catch (error) {
          // Planning/default-mode turns are independent of the goals feature.
          // Ignore only an explicit native disabled/unsupported response, never
          // a disconnect, malformed snapshot, or failure of an actual /goal.
          const unavailable = !goalCommand && error instanceof AppError
            && ['CODEX_STDIO_RPC_ERROR', 'CODEX_DAEMON_RPC_ERROR'].includes(error.code)
            && (error.message === 'goals feature is disabled' || readObjectRecord(error.details)?.rpcCode === -32601);
          if (!unavailable) throw error;
        }
        if (existingGoal?.status === 'active') {
          // Resuming an unloaded active goal can itself start its scheduler.
          // Do not accidentally run an old objective before the new settings,
          // or pause/take over a desktop goal without an explicit user command.
          throw new AppError('This session already has an active native goal. Inspect /goal, then use /goal pause before changing or resuming it from a new Codey run.', {
            code: 'CODEX_GOAL_ALREADY_ACTIVE', statusCode: 409,
          });
        }
      }
      // Attach without changing permissions: the thread may still have an
      // active desktop turn. Apply Codey's selection only at turn/start,
      // if idle. Steering a desktop turn must retain its existing settings.
      let resumed: AnyRecord;
      try {
        resumed = await client.request('thread/resume', { threadId: run.threadId, excludeTurns: true });
      } catch (error) {
        const record = readObjectRecord(error);
        // Only the exact native refusal proves that this prompt has not been
        // submitted. Never queue after an ambiguous turn/start/network failure.
        if (['CODEX_STDIO_RPC_ERROR', 'CODEX_DAEMON_RPC_ERROR'].includes(record?.code)
          && !goalCommand && !planMode
          && error instanceof Error
          && error.message === `thread ${run.threadId} already has an active writer`) {
          if (!run.aborted) await this.runThroughDesktopQueue(run, input, options, writer, context);
          return;
        }
        throw error;
      }
      if (resumed.thread?.id !== run.threadId) {
        throw new Error('Codex did not attach the requested thread. No prompt was submitted.');
      }
      if (run.aborted) return;
      if (resumed.thread?.status?.type === 'active') {
        if (client.ownsProcess || goalCommand || planMode) {
          throw new AppError('This session has an active Codex turn. Native commands and mode changes require an idle session; an ordinary message can be appended through its owning Codex app.', {
            code: 'CODEX_THREAD_BUSY', statusCode: 409,
          });
        }
        run.observesDesktopTurn = true;
        send(writer, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'status', canSteer: false, canInterrupt: false,
        }));
        activeDesktopTurn = await readActiveDesktopTurn(client, run.threadId);
      }
    }
    if (observedTurnId && activeDesktopTurn?.id !== observedTurnId) {
      throw new AppError('The desktop turn ended or changed before attachment. No message was sent and no new turn was started.', {
        code: 'CODEX_OBSERVATION_EXPIRED', statusCode: 409,
      });
    }
    if (run.aborted) return;

    const items = new Map<string, AnyRecord>();
    // Seed in-flight items so a delta received after attaching does not replace
    // an existing assistant message or command output with just its suffix.
    for (const item of Array.isArray(activeDesktopTurn?.items) ? activeDesktopTurn.items : []) {
      if (item && typeof item.id === 'string') items.set(item.id, { ...item });
    }
    // Include hidden native items so history and live snapshots use the same
    // position even when a phone joins hours into one long desktop turn.
    const itemPositions = new Map([...items.keys()].map((id, index) => [id, index]));
    let turnStartedAt = new Date(Number(activeDesktopTurn?.startedAt ?? Date.now() / 1000) * 1000).toISOString();
    const rememberItem = (item: AnyRecord) => {
      if (!itemPositions.has(item.id)) itemPositions.set(item.id, itemPositions.size);
      items.set(item.id, item);
    };
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
      // Identity-bearing native input is the authoritative receipt, and may
      // arrive before turn/steer's acknowledgement and its gateway echo.
      // Older daemons without clientId keep the existing echo-only behavior.
      if (item.type === 'userMessage' && !item.clientId) return;
      for (const raw of projectCodexDaemonItem(item, run.turnId ?? '', new Date().toISOString(), {
        turnId: run.turnId ?? '', turnStartedAt, itemIndex: itemPositions.get(item.id)!,
      })) {
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
      if (method === 'serverRequest/resolved') {
        this.ownedPermissions.resolvedByNative(client, params.requestId);
        return;
      }
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
      if (run.observesDesktopTurn && eventTurnId !== run.turnId) return;
      if (method === 'item/started' || method === 'item/completed') {
        const item = readObjectRecord(params.item);
        if (!item || typeof item.id !== 'string') return;
        rememberItem(item);
        dirtyItems.delete(item.id);
        emitItem(item);
      } else if (method === 'item/agentMessage/delta') {
        const item = items.get(params.itemId) ?? { id: params.itemId, type: 'agentMessage', text: '' };
        item.text = String(item.text || '') + String(params.delta || '');
        rememberItem(item);
        queueItem(item);
      } else if (method === 'item/plan/delta') {
        const item = items.get(params.itemId) ?? { id: params.itemId, type: 'plan', text: '' };
        item.text = String(item.text || '') + String(params.delta || '');
        rememberItem(item);
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
        if (!goalCommand) {
          run.finished = true;
          resolveTurn(readObjectRecord(params.turn) ?? {});
        }
      }
    };
    const offEvent = goalCommand ? () => {} : client.onNotification(handleEvent);
    const offDisconnect = client.onDisconnect(rejectTurn);
    const offRequest = client.onServerRequest((method, params, id) => {
      if (client.ownsProcess) {
        this.ownedPermissions.handle(client, sessionId, run.threadId!, method, params, id, writer);
        return;
      }
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
      if (goalCommand) {
        // One updatable status row per goal run, not a full objective appended
        // for every usage notification in a long-running goal.
        const goalStatusMessage = createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'task_notification', status: 'info',
        });
        run.goal = new CodexGoalRun(client, run.threadId!, {
          onTurn: (id) => {
            flush();
            items.clear();
            itemPositions.clear();
            turnStartedAt = new Date().toISOString();
            run.turnId = id;
            send(writer, createNormalizedMessage({
              provider: 'codex', sessionId, kind: 'status',
              canSteer: Boolean(id), canInterrupt: true,
            }));
          },
          onEvent: handleEvent,
          onGoal: (goal) => send(writer, {
            ...goalStatusMessage,
            summary: formatCodexGoalResult(goal).message,
          }),
        });
        const turn = await run.goal.start(goalCommand, turnSettings);
        run.finished = true;
        send(writer, createCompleteMessage({
          provider: 'codex', sessionId, actualSessionId: run.threadId,
          exitCode: turn.status === 'completed' ? 0 : 1,
          aborted: run.aborted || turn.status === 'interrupted',
        }));
        return;
      }
      if (activeDesktopTurn) {
        // Listeners are installed before submission; completion can precede
        // the acknowledgement. Do not advertise steering until it is accepted.
        if (!observedTurnId) {
          await steerCodexTurn(client, run.threadId!, activeDesktopTurn.id, input, options.clientMessageId);
          send(writer, createNormalizedMessage({
            provider: 'codex', sessionId, kind: 'task_notification', status: 'info',
            summary: 'Message added to the active Codex turn. Its current model, permissions and mode stay unchanged. You can queue, steer or stop in Codey; desktop approvals remain in Codex app.',
          }));
        }
        run.turnId = activeDesktopTurn.id;
      } else {
        const response = await client.request('turn/start', {
          threadId: run.threadId, input,
          ...nativeInputIdentity(options.clientMessageId),
          ...turnSettings,
        });
        if (typeof response.turn?.id !== 'string') {
          throw new Error('Codex did not acknowledge a turn id. Check Codex app before retrying; no exec fallback was started.');
        }
        run.turnId = response.turn.id;
        if (typeof response.turn.startedAt === 'number') {
          turnStartedAt = new Date(response.turn.startedAt * 1000).toISOString();
        }
      }
      for (const [method, params] of earlyEvents) handleEvent(method, params);
      earlyEvents.length = 0;
      if (observedTurnId && !run.finished) {
        // A desktop turn can finish between its snapshot and subscription.
        // Recheck after listeners are installed, without submitting any input.
        const page = await client.request('thread/turns/list', {
          threadId: run.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary',
        });
        const turn = page.data?.[0];
        if (!run.finished && (!turn || turn.id !== observedTurnId)) {
          throw new AppError('The observed desktop turn changed. Refresh the session to follow its current turn.', {
            code: 'CODEX_OBSERVATION_EXPIRED', statusCode: 409,
          });
        }
        if (!run.finished && turn.completedAt != null) handleEvent('turn/completed', { threadId: run.threadId, turn });
      }
      if (this.canSteer(sessionId)) {
        send(writer, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'status', canSteer: true, canInterrupt: this.canInterrupt(sessionId),
        }));
      }
      if (run.aborted && !run.observesDesktopTurn) {
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

  private async runThroughDesktopQueue(
    run: SharedRun, input: AnyRecord[], options: AnyRecord,
    writer: ProviderRuntimeWriter, context: ProviderRuntimeContext,
  ): Promise<void> {
    const sessionId = String(options.sessionId);
    await assertCodexDesktopSelection(run.threadId!, { ...options, cwd: run.workingDirectory });
    if (run.aborted) return;
    const owner = await this.connectDesktopOwner(run.threadId!);
    try {
      if (run.aborted) return;
      send(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'task_notification', status: 'info',
        summary: owner
          ? 'Continuing through the existing Codex Desktop session owner, without taking its writer. The desktop session’s model, permissions and tool approvals are preserved.'
          : 'Codex Desktop owns this session. Sending through its native queue, without taking its writer. This turn uses the desktop session’s model and permissions; desktop tool approvals stay there.',
      }));
      run.desktopQueue = new CodexNativeQueueRun(run.client!, run.threadId!, {
        started: (turnId) => {
          run.turnId = turnId;
          send(writer, createNormalizedMessage({
            provider: 'codex', sessionId, kind: 'status', canSteer: false, canInterrupt: false,
          }));
        },
        item: (item, turnId) => {
          for (const raw of projectCodexDaemonItem(item, turnId, new Date().toISOString())) {
            for (const message of context.normalizeMessage(raw, run.threadId)) send(writer, message);
          }
        },
      }, { clientMessageId: nativeInputIdentity(options.clientMessageId).clientUserMessageId, owner });
      const result = await run.desktopQueue.run(input);
      run.finished = true;
      const turn = result.turn;
      if (turn?.status === 'failed') throw new Error(turn.error?.message || 'The desktop Codex turn failed.');
      send(writer, createCompleteMessage({
        provider: 'codex', sessionId, actualSessionId: run.threadId,
        exitCode: turn?.status === 'completed' ? 0 : 1,
        aborted: result.cancelled || turn?.status === 'interrupted',
      }));
      if (turn?.status === 'completed') {
        (notifyRunStopped as (input: AnyRecord) => void)({
          userId: writer.userId ?? null, provider: 'codex', sessionId,
          sessionName: options.sessionSummary, stopReason: 'completed',
        });
      }
    } finally {
      owner?.close();
    }
  }
}

/** Consumed by CodexProvider; keeps the existing SDK adapter as a legacy fallback. */
export const codexSharedRuntime = new CodexSharedRuntime();
