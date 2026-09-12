import { AppError, readObjectRecord } from '@/shared/index.js';
import type { AnyRecord, CodexGoal, CodexGoalCommand, ICodexRpcClient } from '@/shared/index.js';

import { controlCodexGoal, getCodexGoal, readCodexGoal } from './codex-goal.service.js';

/**
 * Used by CodexSharedRuntime to follow the native scheduler across automatic
 * turns. Codey never submits a continuation prompt or treats the first final
 * answer as goal completion. Controls hold the connection until acknowledged.
 */
export class CodexGoalRun {
  private goal: CodexGoal | null = null;
  private turnId: string | null = null;
  private lastTurn: AnyRecord = { status: 'completed' };
  private revision = 0;
  private controls = 0;
  private activated = false;
  private activationRequested = false;
  private activationObserved = false;
  private cancelled = false;
  private sawTurn = false;
  private closed = false;
  private resolve!: (turn: AnyRecord) => void;
  private reject!: (error: Error) => void;
  private readonly completed = new Promise<AnyRecord>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(
    private readonly client: ICodexRpcClient,
    private readonly threadId: string,
    private readonly callbacks: {
      onTurn(id: string | null): void;
      onEvent(method: string, params: AnyRecord): void;
      onGoal(goal: CodexGoal | null): void;
    },
  ) {
    // A disconnect may reject before a settings/set request finishes.
    void this.completed.catch(() => {});
  }

  async start(command: CodexGoalCommand, settings: AnyRecord): Promise<AnyRecord> {
    if (command.action !== 'set' && command.action !== 'resume') {
      throw new AppError('Only goal creation/resume starts a tracked run.', {
        code: 'INVALID_GOAL_COMMAND', statusCode: 400,
      });
    }
    const offEvent = this.client.onNotification((method, params) => this.receive(method, params));
    const offDisconnect = this.client.onDisconnect((error) => this.reject(error));
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (command.action === 'resume' && !await getCodexGoal(this.client, this.threadId)) {
        throw new AppError('This session has no goal. Use /goal <objective> first.', {
          code: 'GOAL_NOT_FOUND', statusCode: 409,
        });
      }
      // No model turn is submitted here. The native goal scheduler uses these
      // settings, including the user's approval/sandbox selection, on its turns.
      await this.client.request('thread/settings/update', { threadId: this.threadId, ...settings });
      if (this.cancelled) return { status: 'interrupted' };
      this.activationRequested = true;
      this.activationObserved = false;
      this.controls++;
      try {
        const response = await this.client.request('thread/goal/set', {
          threadId: this.threadId, status: 'active',
          ...(command.action === 'set' ? {
            objective: command.objective,
            ...(command.tokenBudget !== undefined ? { tokenBudget: command.tokenBudget } : {}),
          } : {}),
        });
        // A resume may emit an OLD paused/limited snapshot before set replies.
        // Only notifications from an observed activation/turn supersede this
        // acknowledgement (which itself may be older than a fast completed run).
        const acknowledged = readCodexGoal(response.goal, this.threadId);
        if (!acknowledged) throw new Error('Codex did not acknowledge a goal. Check /goal before retrying.');
        if (!this.activationObserved) this.update(acknowledged);
        this.activated = true;
      } finally {
        this.controls--;
      }
      if (this.cancelled) await this.abort();
      this.maybeFinish();
      startupTimer = setTimeout(() => {
        if (!this.sawTurn && this.goal?.status === 'active') {
          this.reject(new AppError('The goal was saved but Codex has not started a turn. Check /goal before retrying; Codey did not submit a second request.', {
            code: 'CODEX_GOAL_START_UNCONFIRMED', statusCode: 504,
          }));
        }
      }, 30_000);
      return await this.completed;
    } catch (error) {
      // A known live goal must not be abandoned in the daemon after a stream
      // or protocol failure. Pause once; never restart/replay its work. A goal
      // notification is also evidence of acceptance if the set reply was lost.
      if (this.activated || (this.goal !== null
        && (command.action === 'resume' || (command.action === 'set' && this.goal.objective === command.objective)))) {
        this.activated = true;
        try { await this.abort(); }
        catch {
          throw new AppError(`${error instanceof Error ? error.message : String(error)} Goal state could not be confirmed; check /goal before resuming.`, {
            code: 'CODEX_GOAL_STATE_UNCONFIRMED', statusCode: 503,
          });
        }
      }
      throw error;
    } finally {
      this.closed = true;
      if (startupTimer) clearTimeout(startupTimer);
      offEvent();
      offDisconnect();
    }
  }

  async control(command: CodexGoalCommand): Promise<CodexGoal | null> {
    if (this.closed) {
      throw new AppError('The goal run just ended. Read /goal again to refresh its state.', {
        code: 'GOAL_RUN_ENDED', statusCode: 409,
      });
    }
    if (!this.activated && !this.sawTurn
      && !['get', 'help', 'edit'].includes(command.action)) {
      throw new AppError('The goal is still starting. Wait for its status before changing it, or use Stop to cancel startup.', {
        code: 'GOAL_STARTING', statusCode: 409,
      });
    }
    this.controls++;
    const revision = this.revision;
    try {
      const goal = await controlCodexGoal(this.client, this.threadId, command);
      if (revision === this.revision) this.update(goal);
      return this.goal;
    } finally {
      this.controls--;
      this.maybeFinish();
    }
  }

  async abort(): Promise<void> {
    this.cancelled = true;
    if (!this.activated) return; // start() observes cancellation before/after set.
    this.controls++;
    try {
      // Pause the native scheduler before interrupting, including in the gap
      // between turns, so Stop cannot accidentally launch another continuation.
      if (this.goal?.status === 'active') {
        const goal = await controlCodexGoal(this.client, this.threadId, { action: 'pause' });
        this.update(goal);
      }
      const turnId = this.turnId;
      if (turnId) {
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
      }
    } finally {
      this.controls--;
      this.maybeFinish();
    }
  }

  private update(goal: CodexGoal | null): void {
    this.goal = goal;
    this.revision++;
    this.callbacks.onGoal(goal);
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.activated && !this.turnId && this.controls === 0 && this.goal?.status !== 'active') {
      this.resolve(this.lastTurn);
    }
  }

  private receive(method: string, params: AnyRecord): void {
    if (params.threadId !== this.threadId || this.closed) return;
    try {
      if (method === 'thread/goal/updated') {
        const goal = readCodexGoal(params.goal, this.threadId);
        if (this.activationRequested && !this.activationObserved && goal?.status !== 'active') {
          // A queued thread/resume snapshot is not evidence that the new
          // activation has already finished. The set reply still applies.
          return;
        }
        if (this.activationRequested && goal?.status === 'active') this.activationObserved = true;
        this.update(goal);
      } else if (method === 'thread/goal/cleared') {
        this.update(null);
      } else if (method === 'turn/started') {
        const id = params.turn?.id;
        if (typeof id !== 'string' || !id) return;
        this.sawTurn = true;
        if (this.activationRequested) this.activationObserved = true;
        this.turnId = id;
        this.callbacks.onTurn(id);
      } else {
        const eventTurn = params.turnId ?? params.turn?.id;
        if (!this.turnId || (eventTurn && eventTurn !== this.turnId)) return;
        this.callbacks.onEvent(method, params);
        if (method !== 'turn/completed') return;
        this.lastTurn = readObjectRecord(params.turn) ?? {};
        this.turnId = null;
        this.callbacks.onTurn(null);
        if (this.lastTurn.status === 'failed') {
          this.reject(new Error(this.lastTurn.error?.message || 'The native goal turn failed. Check /goal before resuming.'));
          return;
        }
        this.maybeFinish();
        // A terminal goal notification may lag turn/completed. Read, don't
        // infer completion from a final answer or create our own next turn.
        if (this.goal?.status === 'active') {
          void this.control({ action: 'get' }).catch((error: Error) => this.reject(error));
        }
      }
    } catch (error) {
      this.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
