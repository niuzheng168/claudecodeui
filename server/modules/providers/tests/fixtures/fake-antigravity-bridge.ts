import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const emit = (event: string, value: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...value }));
const mode = process.env.FAKE_ANTIGRAVITY_MODE || 'text';
let started = false;
let conversationId = '';
let answerId = '';
const finish = () => {
  emit('step', { step: {
    id: answerId, step_index: 1, source: 'MODEL', target: 'TARGET_USER',
    status: 'DONE', content: 'Google response', content_delta: '',
  } });
  emit('result', { usage: { prompt_token_count: 21, candidates_token_count: 4, total_token_count: 25 } });
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
    emit('step', { step: {
      id: answerId, step_index: 1, source: 'MODEL', target: 'TARGET_USER',
      status: 'ACTIVE', content_delta: 'Google response',
    } });
    if (mode === 'permission') {
      emit('permission', { requestId: 'approval-1', toolName: 'run_command', input: { command: 'echo hello' } });
    } else if (mode === 'question') {
      emit('permission', { requestId: 'question-1', toolName: 'AskUserQuestion', question: true,
        input: { questions: [{ question: 'Choose a name', options: [{ id: 'one', text: 'First' }], is_multi_select: false }] } });
    } else if (mode === 'error') {
      emit('error', { message: 'Fixture upstream error' });
      process.exit(1);
    } else if (mode === 'cancelled') {
      emit('result', { cancelled: true });
    } else if (mode !== 'hold') finish();
  } else if (value.event === 'decision') {
    emit('tool_result', { result: { id: 'tool-1', name: 'run_command',
      result: value.allow ? 'allowed' : 'denied', error: value.allow ? null : 'Permission denied' } });
    finish();
  } else if (value.event === 'cancel') {
    emit('result', { cancelled: true });
    process.exit(0);
  }
});
