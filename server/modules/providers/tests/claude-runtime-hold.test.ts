import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  getClaudeSDKSessionStartTime,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  retireIdleClaudeProcesses,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 *
 * A session's process normally stays resident between turns, so "released"
 * only means "exits" with resident processes turned off
 * (CLAUDE_MAX_IDLE_PROCESSES=0), which these tests run with unless they say
 * otherwise. The scripted models are not in the Codey-managed catalog, so the
 * managed gateway is off as well.
 */

const SETTINGS = ['CODEY_MANAGED', 'CLAUDE_MAX_IDLE_PROCESSES'];
const previousSettings = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));

before(() => {
  delete process.env.CODEY_MANAGED;
  process.env.CLAUDE_MAX_IDLE_PROCESSES = '0';
});

after(async () => {
  await retireIdleClaudeProcesses();
  for (const [name, value] of Object.entries(previousSettings)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  interrupts: () => number;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let interrupts = 0;
  const stopped: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    interrupts: () => interrupts,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => { interrupts += 1; },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown> }) => Promise<void>,
  contextOverrides: Partial<ProviderRuntimeContext> = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
    ...contextOverrides,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await runTest({ script, sent, done });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a new turn stops the tasks the held process still has going before letting it go', async () => {
  // Two runs on one session, each with its own scripted CLI: the first is
  // held for a background agent, the second is the user's next message.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // Closing stdin alone would leave the CLI waiting for the agent, so the
    // superseded process would live on next to the new one for as long as
    // the agent runs. The stop has to reach it before stdin ends, because the
    // SDK drops control requests written to an ended stdin.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
    assert.equal(first.script.released(), true, 'and is then let go');
    assert.deepEqual(second.script.stopped, [], 'the new process is untouched');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

/** Runs a test body with the default resident processes instead of one process per turn. */
async function withResidentProcesses(body: () => Promise<void>): Promise<void> {
  const previous = process.env.CLAUDE_MAX_IDLE_PROCESSES;
  delete process.env.CLAUDE_MAX_IDLE_PROCESSES;
  try {
    await body();
  } finally {
    await retireIdleClaudeProcesses();
    process.env.CLAUDE_MAX_IDLE_PROCESSES = previous;
  }
}

test('with resident processes, stopping the last task ends the hold and keeps the process for the next turn', async () => {
  await withResidentProcesses(() => withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.sessionId), [SESSION_ID]);

    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(getClaudeSDKSessionStartTime(SESSION_ID) !== null, true, 'the process stays resident');
    assert.equal(script.released(), false, 'resident, not held: stdin stays open for the next turn');
  }));
});

test('with resident processes, a new turn that cannot reuse the held process stops its tasks before letting it go', async () => {
  await withResidentProcesses(async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
    const first = createScriptedQuery();
    const second = createScriptedQuery();
    const sent: NormalizedMessage[] = [];
    const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
    const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
    };

    try {
      const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
      await settle();
      first.script.emit(init());
      first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
      first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
      first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
      first.script.emit(result());
      await waitFor(() => sent.some((message) => message.kind === 'complete'));
      assert.equal(first.script.released(), false, 'the first process is held for its agent');

      // Nothing to resume, so the new turn needs a process of its own; the
      // resident one must not keep its agent running next to it.
      const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: second.createQuery });
      await settle();
      assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
      assert.equal(first.script.released(), true, 'and is then let go');

      first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
      first.script.end();
      await firstRun;
      second.script.emit(init());
      second.script.emit(result());
      await secondRun;
      assert.deepEqual(second.script.stopped, [], 'the new process is untouched');
      assert.equal(second.script.released(), false, 'the new process stays resident');
      second.script.end();
      assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/** Stands in for the run registry's hook: records each run it opens and what goes through it. */
function createFollowUpRuns({ inProgress = false } = {}) {
  const opened: Array<{ args: unknown[]; sent: NormalizedMessage[] }> = [];
  const startFollowUpRun: NonNullable<ProviderRuntimeContext['startFollowUpRun']> = (...args) => {
    const run = { args, sent: [] as NormalizedMessage[] };
    opened.push(run);
    // A run already in progress leaves the turn without one of its own.
    return inProgress ? null : { send: (message) => { run.sent.push(message as NormalizedMessage); }, userId: null };
  };
  return { opened, startFollowUpRun };
}

const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** The client's turn launches background agents and ends. */
function launchBackgroundAgents(script: Scripted, taskIds: string[]) {
  script.emit(init());
  for (const taskId of taskIds) {
    script.emit(toolUse(`toolu_${taskId}`, 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted(taskId, `toolu_${taskId}`, 'local_agent'));
    script.emit(ack(`toolu_${taskId}`, 'Async agent launched successfully.', { status: 'async_launched', agentId: taskId }));
  }
  script.emit(result());
}

const completes = (messages: NormalizedMessage[]) => messages.filter((message) => message.kind === 'complete');

test('a turn the CLI starts on its own runs in a run of its own', async () => {
  const followUps = createFollowUpRuns();
  await withRun(async ({ script, sent }) => {
    launchBackgroundAgents(script, ['a1']);
    await waitFor(() => completes(sent).length === 1);

    // The agent reports, and the CLI relays it in a turn nobody sent.
    script.emit(taskNotification('a1', 'toolu_a1', 'completed'));
    script.emit(init());
    script.emit(assistantText('The agent finished.'));
    script.emit(result());
    await waitFor(() => completes(followUps.opened[0]?.sent ?? []).length === 1);

    assert.deepEqual(followUps.opened.map((run) => run.args), [[SESSION_ID, NATIVE_ID, null]]);
    const [followUp] = followUps.opened;
    assert.equal(followUp.sent[0].kind, 'status', 'the session is busy from the turn\'s start');
    assert.equal(followUp.sent[0].canInterrupt, true);
    assert.ok(followUp.sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'));
    assert.equal(completes(followUp.sent)[0].exitCode, 0);
    assert.equal(sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'), false,
      'the turn does not go to the client turn\'s writer');
    assert.equal(completes(sent).length, 1);
    assert.equal(script.released(), true, 'nothing is outstanding after the turn, so the process is let go');
  }, { startFollowUpRun: followUps.startFollowUpRun });
});

test('a turn the CLI starts while a run is in progress goes to the writer it has', async () => {
  const followUps = createFollowUpRuns({ inProgress: true });
  await withRun(async ({ script, sent }) => {
    launchBackgroundAgents(script, ['a1']);
    await waitFor(() => completes(sent).length === 1);

    script.emit(taskNotification('a1', 'toolu_a1', 'completed'));
    script.emit(init());
    script.emit(assistantText('The agent finished.'));
    script.emit(result());
    await waitFor(() => script.released());

    assert.equal(followUps.opened.length, 1, 'a run was asked for');
    assert.ok(sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'));
    assert.equal(completes(sent).length, 1, 'and no run of its own is ended');
  }, { startFollowUpRun: followUps.startFollowUpRun });
});

test('a turn the CLI started on its own still ends its run when the process does', async () => {
  const followUps = createFollowUpRuns();
  await withRun(async ({ script, sent }) => {
    launchBackgroundAgents(script, ['a1']);
    await waitFor(() => completes(sent).length === 1);

    script.emit(taskNotification('a1', 'toolu_a1', 'completed'));
    script.emit(init());
    script.end();
    await waitFor(() => completes(followUps.opened[0]?.sent ?? []).length === 1);

    assert.equal(completes(followUps.opened[0].sent)[0].exitCode, 1);
  }, { startFollowUpRun: followUps.startFollowUpRun });
});

test('stopping a turn the CLI started on its own keeps the process for the work still going', async () => {
  const followUps = createFollowUpRuns();
  await withRun(async ({ script, sent }) => {
    launchBackgroundAgents(script, ['a1', 'a2']);
    await waitFor(() => completes(sent).length === 1);

    script.emit(taskNotification('a1', 'toolu_a1', 'completed'));
    script.emit(init());
    await waitFor(() => followUps.opened.length === 1);

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.interrupts(), 1);
    // The interrupted turn ends; the caller has already ended its run.
    script.emit(result());
    await settle();

    assert.deepEqual(completes(followUps.opened[0].sent), []);
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['a2']]);
    assert.equal(script.released(), false, 'the second agent keeps its process');
  }, { startFollowUpRun: followUps.startFollowUpRun });
});
