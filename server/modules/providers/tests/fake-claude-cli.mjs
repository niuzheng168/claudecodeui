#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by claude-steering.test.ts. It speaks
// the SDK's stream-json protocol and reproduces how the real CLI treats stdin
// input that arrives mid-turn (measured against the bundled CLI):
// - it is folded into the running turn after the next tool result, and
//   echoed back with `isReplay` when --replay-user-messages is set;
// - with no tool boundary left, it runs as a follow-up turn after `result`;
// - `cancel_async_message` drops it, otherwise it still runs after an interrupt.
// The prompt picks the turn: TOOL (tool call that ends when input arrives),
// SLOW_TOOL (5s tool call only an interrupt ends), WAIT_TEXT (final text,
// then waits for input), ECHO_UUID (answers with the uuid the prompt carried,
// which the real CLI keeps as the transcript row's uuid). `/context` and
// `/compact` replay what the real CLI streams for those local commands, and
// `initialize` reports a command list shaped like the real one. ECHO_PID
// answers with the process id, so tests can tell a reused process from a new
// one; BG_TASK starts background work that reports back in a turn of its own
// shortly after the result, like a finished background shell does, and
// BG_TASK_DUE background work whose report is ready just as the next input
// arrives, so the CLI runs the report first.
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const replay = process.argv.includes('--replay-user-messages');
// Resuming keeps the session id, like the real CLI.
const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt > 0 ? process.argv[resumeAt + 1] : randomUUID();
const BG_REPORT_DELAY_MS = 150;
const queue = [];
let turn = null;
let inputEnded = false;
let wakeTurn = null;
let reportDue = false;

const emit = (message) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, uuid: randomUUID(), ...message })}\n`);
const textOf = (message) => (typeof message.message.content === 'string'
  ? message.message.content
  : message.message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
const echo = (message) => {
  if (replay) emit({ type: 'user', message: message.message, parent_tool_use_id: null, isReplay: true, uuid: message.uuid ?? randomUUID() });
};
const assistant = (content) => emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } });
// Local command output: a reply that never called the model.
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const synthetic = (text, uuid = randomUUID()) => emit({
  type: 'assistant', parent_tool_use_id: null, uuid,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], usage: ZERO_USAGE },
});
const COMMANDS = [
  { name: 'clear', description: 'Start a new session with empty context', argumentHint: '[name]', aliases: ['reset', 'new'] },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
  { name: 'context', description: 'Show current context usage', argumentHint: '' },
  { name: 'usage', description: 'Show the total cost and duration of the current session', argumentHint: '', aliases: ['cost', 'stats'] },
  { name: 'goal', description: 'Set a goal — keep working until the condition is met', argumentHint: '' },
  { name: 'simplify', description: 'Review the changed code for cleanups', argumentHint: '[<target>]' },
  { name: 'my-user-skill', description: 'A skill from the user\'s own folder', argumentHint: '' },
];
// Resolves when input arrives, the turn is interrupted, or the timeout passes.
const wait = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  wakeTurn = () => { clearTimeout(timer); resolve(); };
});

async function runTurn(first) {
  turn = { interrupted: false, wakeOnInput: false };
  if (first.type === 'background-report') {
    emit({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed', summary: 'Background shell finished' });
    emit({ type: 'system', subtype: 'init', model: 'fake-model', tools: [] });
    // The follow-up takes a while, so a prompt sent meanwhile has to wait for it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assistant([{ type: 'text', text: 'background report' }]);
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  emit({ type: 'system', subtype: 'init', model: 'fake-model', tools: [] });
  const prompt = textOf(first);
  // A local command is never echoed back, even with --replay-user-messages.
  if (!prompt.startsWith('/')) echo(first);
  const steered = [];
  if (prompt === '/context') {
    synthetic('## Context Usage\n\n**Tokens:** 30.4k / 633k (5%)');
    emit({ type: 'result', subtype: 'success', is_error: false, result: '## Context Usage', num_turns: 0, usage: ZERO_USAGE });
    return;
  }
  if (prompt === '/compact') {
    emit({ type: 'system', subtype: 'status', status: 'compacting' });
    emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
    const summaryId = randomUUID();
    emit({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual', pre_tokens: 30689, post_tokens: 403,
        preserved_messages: { anchor_uuid: summaryId, uuids: ['kept-before-compact'] },
      },
    });
    emit({
      type: 'user', parent_tool_use_id: null, uuid: summaryId, isSynthetic: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. The user asked for OK.' },
    });
    // The kept tail is streamed again for clients rebuilding the conversation.
    synthetic('Total cost: $0.0000', 'kept-before-compact');
    emit({ type: 'user', parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, usage: ZERO_USAGE });
    return;
  }
  if (prompt.includes('TOOL')) {
    assistant([{ type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: { command: 'sleep' } }]);
    turn.wakeOnInput = !prompt.includes('SLOW_TOOL');
    if (!queue.length || !turn.wakeOnInput) await wait(turn.wakeOnInput ? 3000 : 5000);
    if (turn.interrupted) {
      emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake', content: 'interrupted', is_error: true }] } });
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], num_turns: 1 });
      return;
    }
    emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake', content: 'ok' }] } });
    // Input that arrived during the tool call joins this turn.
    for (const message of queue.splice(0)) {
      echo(message);
      steered.push(textOf(message));
    }
    assistant([{ type: 'text', text: `done: ${[prompt, ...steered].join(' + ')}` }]);
  } else if (prompt.includes('WAIT_TEXT')) {
    turn.wakeOnInput = true;
    assistant([{ type: 'text', text: `answer: ${prompt}` }]);
    // No tool boundary is left, so input arriving now waits for the next turn.
    if (!queue.length) await wait(3000);
  } else if (prompt.includes('ECHO_PID')) {
    assistant([{ type: 'text', text: `pid: ${process.pid}` }]);
  } else if (prompt.includes('BG_TASK')) {
    assistant([{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }]);
    emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'started in background' }] } });
    assistant([{ type: 'text', text: 'started' }]);
    if (prompt.includes('BG_TASK_DUE')) {
      reportDue = true;
    } else {
      setTimeout(() => { queue.unshift({ type: 'background-report' }); void drain(); }, BG_REPORT_DELAY_MS);
    }
  } else if (prompt.includes('ECHO_UUID')) {
    assistant([{ type: 'text', text: `uuid: ${first.uuid ?? 'none'}` }]);
  } else {
    assistant([{ type: 'text', text: `answer: ${prompt}` }]);
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
}

async function drain() {
  while (!turn && queue.length) {
    try {
      await runTurn(queue.shift());
    } finally {
      turn = null;
    }
  }
  if (!turn && inputEnded) process.exit(0);
}

function respond(request, response = {}) {
  emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const { subtype } = message.request;
    if (subtype === 'cancel_async_message') {
      const index = queue.findIndex((queued) => queued.uuid === message.request.message_uuid);
      if (index >= 0) queue.splice(index, 1);
      respond(message, { cancelled: index >= 0 });
    } else if (subtype === 'interrupt') {
      if (turn) turn.interrupted = true;
      wakeTurn?.();
      respond(message);
    } else if (subtype === 'initialize') {
      respond(message, { commands: COMMANDS, agents: [], models: [] });
    } else {
      respond(message);
    }
    return;
  }
  if (message.type !== 'user') return;
  queue.push(message);
  if (reportDue) {
    reportDue = false;
    queue.unshift({ type: 'background-report' });
  }
  if (turn) {
    if (turn.wakeOnInput) wakeTurn?.();
  } else {
    void drain();
  }
}).on('close', () => {
  inputEnded = true;
  void drain();
});
