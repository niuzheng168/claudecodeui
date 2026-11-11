import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const emit = (event: string, value: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...value }));
const mode = process.env.FAKE_ANTIGRAVITY_MODE || 'text';
if (mode === 'managed' && (process.env.CODEY_MODEL_API_KEY || process.env.GEMINI_API_KEY)) {
  throw new Error('Managed SDK inherited a proxy or Google credential');
}
let started = false;
let conversationId = '';
let answerId = '';
let total = 25;
const finish = () => {
  emit('step', { step: {
    id: answerId, step_index: 1, source: 'MODEL', target: 'TARGET_USER',
    status: 'DONE', content: 'Google response', content_delta: '',
  } });
  emit('result', { usage: { total_token_count: total } });
  process.exitCode = 0;
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const value = JSON.parse(line);
  if (!started) {
    started = true;
    conversationId = value.conversationId;
    answerId = `${conversationId}:${value.resume ? 3 : 1}`;
    if (process.env.FAKE_ANTIGRAVITY_CAPTURE) writeFileSync(process.env.FAKE_ANTIGRAVITY_CAPTURE, JSON.stringify(value));
    if (mode === 'malformed') { console.log('not json'); return; }
    if (mode === 'startup-hang') return;
    emit('ready', { conversationId });
    if (mode.startsWith('usage')) {
      const directory = path.join(value.stateDir, 'app', 'brain', conversationId, '.system_generated', 'logs');
      const log = () => {
        mkdirSync(directory, { recursive: true });
        appendFileSync(path.join(directory, 'transcript_full.jsonl'), JSON.stringify({
          step_index: value.resume ? 3 : 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
          input_tokens: value.resume ? 60 : 40, cache_read_tokens: value.resume ? 100 : 60,
          output_tokens: value.resume ? 10 : 25,
        }) + '\n');
      };
      if (mode === 'usage-late') process.once('exit', log);
      else if (mode === 'usage-unreadable') {
        mkdirSync(path.join(value.stateDir, 'app'), { recursive: true });
        writeFileSync(path.join(value.stateDir, 'app', 'brain'), 'not a directory');
      } else log();
      total = value.resume ? 295 : 125;
      emit('usage', { usage: { total_token_count: total } });
      emit('usage', { usage: { total_token_count: total } });
      if (mode === 'usage-error') { emit('error', { message: 'Failure after model call' }); process.exit(1); }
    }
    emit('step', { step: {
      id: answerId, step_index: 1, source: 'MODEL', target: 'TARGET_USER',
      status: 'ACTIVE', content_delta: 'Google response',
    } });
    if (mode === 'permission') {
      emit('step', { step: { id: 'native-tool-step', status: 'ACTIVE', source: 'MODEL', target: 'TARGET_TOOL',
        tool_calls: [{ id: 'native-tool-step', step_id: 'native-tool-step', name: 'run_command', args: { command: 'echo hello' } }] } });
      emit('tool_start', { tool: { id: 'copilot-call-id', step_id: 'native-tool-step', name: 'run_command', args: { command: 'echo hello' } } });
      emit('permission', { requestId: 'approval-1', toolName: 'run_command', input: { command: 'echo hello' } });
    } else if (mode === 'question') {
      emit('permission', { requestId: 'question-1', toolName: 'AskUserQuestion', question: true,
        input: { questions: [{ question: 'Choose a name', options: [{ id: 'one', text: 'First' }], is_multi_select: false }] } });
    } else if (mode === 'error') {
      emit('error', { message: 'Fixture upstream error' });
      process.exit(1);
    } else if (mode === 'cancelled') {
      emit('result', { cancelled: true });
    } else if (mode !== 'hold' && mode !== 'usage-hold') finish();
  } else if (value.event === 'decision') {
    emit('tool_result', { result: { id: 'copilot-call-id', step_id: 'different-result-step', name: 'run_command',
      result: value.allow ? 'allowed' : 'denied', error: value.allow ? null : 'Permission denied' } });
    finish();
  } else if (value.event === 'cancel') {
    emit('result', { cancelled: true });
    process.exit(0);
  }
});
