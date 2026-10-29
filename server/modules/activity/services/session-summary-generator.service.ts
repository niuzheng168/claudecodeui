import { codeyClaudeGateway, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  SESSION_SUMMARY_INSTRUCTIONS, SESSION_SUMMARY_SCHEMA, fallbackSessionSummary, parseSessionSummary,
  readBoundedJsonResponse, readResponsesOutputText,
} from '@/shared/index.js';
import type { NormalizedMessage, SessionSummaryRequest } from '@/shared/index.js';

/**
 * Writes one session's one-line summary (docs/codey-project-overview-design.md
 * §9.3) from the user messages of the turns it covers and the agent's last
 * reply, nothing else of the conversation (§11).
 *
 * The model runs behind the node's own model API, its Copilot proxy. A node
 * without one, and a short turn (`SHORT_TURN_MS` or less, no tool calls), get
 * the first sentence of the last reply instead, as does a model call that
 * fails. Nothing read or written here is logged or kept.
 */

/** The model summaries use unless CODEY_SUMMARY_MODEL names another; Portal settings are numbers only. */
const DEFAULT_SUMMARY_MODEL = 'gpt-6.1-terra';
/**
 * The newest history rows read for a summary. A turn full of tool calls takes
 * many rows, and a hundred is still one native Codex page.
 */
const HISTORY_ROWS = 100;
const MAX_INPUT_CHARACTERS = 6_000;
const MAX_REPLY_CHARACTERS = 3_000;
const MAX_NOTE_CHARACTERS = 600;
const MAX_USER_MESSAGE_CHARACTERS = 1_500;
/** A user message shorter than this is not worth squeezing into what is left of the input. */
const MIN_USER_MESSAGE_CHARACTERS = 200;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Leaves time for the first-sentence summary within the scheduler's 30-second deadline. */
const MODEL_TIMEOUT_MS = 20_000;
const SHORT_TURN_MS = 10_000;
/** A turn's first rows can be stamped a little before this machine saw the turn start. */
const SEGMENT_SLACK_MS = 30_000;

/** What a summary is written from. */
type SummaryMaterial = {
  /** The session's newest history rows, oldest first. */
  history: NormalizedMessage[];
  /** The events of the session's latest CloudCLI run, when it began within the turns summarized. */
  runEvents: NormalizedMessage[];
};

type SummaryContent = {
  userMessages: string[];
  reply: string | null;
  /** What a session waiting on a question asks. */
  question: string | null;
  /** How a failed CloudCLI run ended. */
  error: string | null;
  usedTools: boolean;
};

type ModelEndpoint = { url: string; headers: Record<string, string> };

type GeneratorDependencies = {
  readMaterial?: (request: SessionSummaryRequest) => Promise<SummaryMaterial>;
  /** The node's model API, or null when it has none. */
  modelEndpoint?: () => ModelEndpoint | null;
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
};

/** The newest history rows, and the session's CloudCLI run if it belongs to these turns. Unreadable history is no history. */
async function readSessionMaterial(request: SessionSummaryRequest): Promise<SummaryMaterial> {
  let history: NormalizedMessage[] = [];
  try {
    history = (await sessionsService.fetchHistory(request.sessionId, { limit: HISTORY_ROWS })).messages;
  } catch {
    // A session without a readable transcript is skipped quietly.
  }
  const run = chatRunRegistry.getRun(request.sessionId);
  const current = run && run.startedAt >= request.segmentStartedAt - SEGMENT_SLACK_MS;
  return { history, runEvents: current ? run.events : [] };
}

/** The node's Copilot proxy; a node without a configured model API has none. */
function defaultModelEndpoint(): ModelEndpoint | null {
  try {
    return codeyClaudeGateway.responsesRequest();
  } catch {
    return null;
  }
}

function textOf(message: NormalizedMessage): string {
  return typeof message.content === 'string' ? message.content.trim() : '';
}

/** The newest prose the agent wrote, not a compaction summary or a local command's output. */
function lastReply(messages: NormalizedMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === 'text' && message.role === 'assistant' && !message.isCompactSummary
      && !message.isLocalCommandStdout && textOf(message)) return textOf(message);
  }
  return null;
}

/** The questions of the newest AskUserQuestion call: what the session waits for the user to answer. */
function lastQuestion(messages: NormalizedMessage[], inTurns: (message: NormalizedMessage) => boolean): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind !== 'tool_use' || message.toolName !== 'AskUserQuestion') continue;
    if (!inTurns(message)) return null;
    const questions = (message.toolInput as { questions?: unknown } | null)?.questions;
    const texts = Array.isArray(questions)
      ? questions.map((entry) => (entry as { question?: unknown } | null)?.question)
        .filter((question): question is string => typeof question === 'string' && Boolean(question.trim()))
      : [];
    return texts.length ? texts.join(' / ') : null;
  }
  return null;
}

/** Picks what the summary may read: this segment's user messages and the agent's last word. */
function readSummaryContent(request: SessionSummaryRequest, material: SummaryMaterial): SummaryContent {
  const since = request.segmentStartedAt - SEGMENT_SLACK_MS;
  const inTurns = (message: NormalizedMessage) => {
    const time = Date.parse(message.timestamp);
    return Number.isFinite(time) && time >= since;
  };
  const userRows = material.history.filter((message) => (
    message.kind === 'text' && message.role === 'user' && !message.isLocalCommand && textOf(message)
  ));
  let userMessages = userRows.filter(inTurns).map(textOf);
  // A turn begun by a task or with no stamped input still answers the latest request.
  if (!userMessages.length && userRows.length) userMessages = [textOf(userRows[userRows.length - 1])];
  const errorEvent = request.reason === 'failed'
    ? [...material.runEvents].reverse().find((event) => event.kind === 'error' && textOf(event))
    : undefined;
  return {
    userMessages,
    reply: lastReply(material.history) ?? lastReply(material.runEvents),
    question: request.reason === 'waiting' && request.waitingKind === 'question'
      ? lastQuestion(material.history, inTurns) ?? lastQuestion(material.runEvents, () => true)
      : null,
    error: errorEvent ? textOf(errorEvent) : null,
    usedTools: material.history.some((message) => message.kind === 'tool_use' && inTurns(message))
      || material.runEvents.some((event) => event.kind === 'tool_use'),
  };
}

/** The head and the tail of a long text, which is where replies say what happened. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.6);
  const tail = limit - head - 3;
  return `${text.slice(0, head).trimEnd()}\n…\n${text.slice(text.length - tail).trimStart()}`;
}

function describeState(request: SessionSummaryRequest): string {
  switch (request.reason) {
    case 'waiting':
      if (request.waitingKind === 'question') return 'the agent asked the user a question and waits for the answer.';
      if (request.waitingKind === 'permission') return 'the agent waits for the user to allow an action.';
      return 'the agent waits for the user.';
    case 'failed':
      return 'the agent\'s last turn ended with an error.';
    case 'settled':
      return 'the turn has ended and the agent waits for the user\'s next message.';
    case 'continuous':
      return 'the agent keeps working turn after turn; this is a progress update.';
  }
}

/** The model's input: the state, then the user messages and the last reply within about 6,000 characters. */
function composeSummaryInput(request: SessionSummaryRequest, content: SummaryContent): string {
  const reply = content.reply ? clip(content.reply, MAX_REPLY_CHARACTERS) : '(none)';
  const notes = [
    ...(content.question ? [`The agent's question: ${clip(content.question, MAX_NOTE_CHARACTERS)}`] : []),
    ...(content.error ? [`The error: ${clip(content.error, MAX_NOTE_CHARACTERS)}`] : []),
  ];
  let budget = MAX_INPUT_CHARACTERS - reply.length - notes.join('\n').length;
  // The newest user messages matter most; older ones fill what is left.
  const userMessages: string[] = [];
  for (const message of [...content.userMessages].reverse()) {
    const room = Math.min(MAX_USER_MESSAGE_CHARACTERS, budget);
    if (room < Math.min(MIN_USER_MESSAGE_CHARACTERS, message.length)) break;
    const clipped = clip(message, room);
    userMessages.unshift(clipped);
    budget -= clipped.length;
  }
  return [
    `Session state: ${describeState(request)}`,
    userMessages.length
      ? `User messages since the last status, oldest first:\n${userMessages.map((message, index) => `[${index + 1}] ${message}`).join('\n')}`
      : 'User messages since the last status: (none)',
    `The agent's last reply:\n${reply}`,
    ...notes,
  ].join('\n\n');
}

async function requestModelSummary(
  endpoint: ModelEndpoint,
  input: string,
  signal: AbortSignal,
  dependencies: GeneratorDependencies,
): Promise<string | null> {
  const model = (dependencies.environment ?? process.env).CODEY_SUMMARY_MODEL?.trim() || DEFAULT_SUMMARY_MODEL;
  const response = await (dependencies.fetch ?? fetch)(endpoint.url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
    headers: { ...endpoint.headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model,
      instructions: SESSION_SUMMARY_INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
      tools: [], tool_choice: 'none', store: false, stream: false, max_output_tokens: 512,
      ...(/^(?:gpt-[5-9](?:[.-]|$)|o[1-9])/i.test(model) ? { reasoning: { effort: 'low' } } : {}),
      text: { format: { type: 'json_schema', name: 'session_summary', strict: true, schema: SESSION_SUMMARY_SCHEMA } },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const text = readResponsesOutputText(await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES));
  return text === null ? null : parseSessionSummary(text);
}

/**
 * Used by the activity reporter's summary scheduler, and by tests with
 * injected material, endpoint and transport. Returns the summary line, or null
 * when the session has nothing to summarize. Rejects only when `signal`
 * aborts, the scheduler's deadline for the whole job.
 */
export async function generateSessionSummary(
  request: SessionSummaryRequest,
  signal: AbortSignal,
  dependencies: GeneratorDependencies = {},
): Promise<string | null> {
  const material = await (dependencies.readMaterial ?? readSessionMaterial)(request);
  signal.throwIfAborted();
  const content = readSummaryContent(request, material);
  // What the session itself said last: the error of a failure, the question of a question.
  const lastWord = (request.reason === 'failed' && content.error)
    || content.question || content.reply || content.error;
  if (!lastWord && !content.userMessages.length) return null;
  const firstSentence = () => (lastWord ? fallbackSessionSummary(lastWord) : null);

  const short = (request.reason === 'settled' || request.reason === 'continuous')
    && request.turnEndedAt !== undefined && request.turnEndedAt - request.segmentStartedAt <= SHORT_TURN_MS
    && !content.usedTools;
  const endpoint = short ? null : (dependencies.modelEndpoint ?? defaultModelEndpoint)();
  if (!endpoint) return firstSentence();
  try {
    const summary = await requestModelSummary(endpoint, composeSummaryInput(request, content), signal, dependencies);
    if (summary) return summary;
  } catch (error) {
    // Past the job's deadline nothing more is written; a failed model call gets the first sentence.
    if (signal.aborted) throw error;
  }
  return firstSentence();
}
