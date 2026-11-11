import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { AntigravityMcpProvider } from '@/modules/providers/list/antigravity/antigravity-mcp.provider.js';
import {
  antigravityBridge, antigravityPython, readAntigravityCredentials,
} from '@/modules/providers/list/antigravity/antigravity-settings.service.js';
import {
  antigravitySessionStore, AntigravitySessionSynchronizer,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import {
  createCompleteMessage, createNormalizedMessage, readObjectRecord, readOptionalString,
  normalizeAttachmentDescriptors, resolveImageAbsolutePath, isAllowedImageSourcePath,
} from '@/shared/index.js';
import type {
  AnyRecord, IProviderRuntime, NormalizedMessage, ProviderPermissionDecision,
  ProviderRuntimeContext, ProviderRuntimeWriter,
} from '@/shared/index.js';

type PendingPrompt = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  context: { canRemember: false };
  receivedAt: Date;
  answer(decision: ProviderPermissionDecision): void;
};
type Turn = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
  aborted: boolean;
  stopping?: Promise<boolean>;
};

const provider = 'antigravity' as const;
const stringify = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '');

/** Registry and focused runtime tests create isolated SDK transports and turn registries. */
export function createAntigravityRuntime(dependencies: {
  createBridge?: (cwd: string) => ChildProcessWithoutNullStreams;
  startupTimeoutMs?: number;
  approvalTimeoutMs?: number;
} = {}): IProviderRuntime {
  const turns = new Map<string, Turn>();
  const prompts = new Map<string, PendingPrompt>();

  async function workspaceInstructions(cwd: string): Promise<string> {
    const sections: string[] = [];
    for (const name of ['AGENTS.md', 'GEMINI.md']) {
      try {
        const text = await readFile(path.join(cwd, name), 'utf8');
        sections.push(`${name}:\n${text}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return sections.join('\n\n');
  }

  async function stopChild(turn: Turn, userAbort = true): Promise<boolean> {
    if (userAbort) turn.aborted = true;
    if (turn.child.stdin.writable) turn.child.stdin.write('{"event":"cancel"}\n');
    let timer: ReturnType<typeof setTimeout>;
    const exited = await Promise.race([
      turn.closed.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5_000); }),
    ]);
    clearTimeout(timer!);
    if (!exited) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill', ['/pid', String(turn.child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => resolve());
          killer.on('exit', () => resolve());
        });
      } else if (turn.child.pid) {
        try { process.kill(-turn.child.pid, 'SIGKILL'); }
        catch { turn.child.kill('SIGKILL'); }
      }
      await turn.closed;
    }
    return true;
  }

  async function run(
    command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext,
  ) {
    const appId = readOptionalString(options.sessionId);
    const nativeId = context.resolveProviderSessionId(appId) ?? randomUUID();
    const key = appId ?? nativeId;
    if (turns.has(key)) throw new Error('An Antigravity turn is already running for this session.');
    let turn: Turn | undefined;
    let failed: string | null = null;
    let ready = false;
    let resultReceived = false;
    const requestIds = new Set<string>();
    const recordedTexts = new Set<string>();
    const texts = new Map<string, { content: string; thinking: string }>();
    const toolIds = new Set<string>();
    const turnId = randomUUID();
    const emit = (fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>) => {
      const message = createNormalizedMessage({ ...fields, provider, sessionId: key });
      writer.send(message);
      return message;
    };
    const record = (message: NormalizedMessage) => antigravitySessionStore.append(nativeId, message);
    const reportError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!failed) emit({ kind: 'error', content: message });
      failed ??= message;
    };
    let model = '';
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cwd = await realpath(readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? process.cwd());
      const existing = await antigravitySessionStore.read(nativeId);
      if (existing && await realpath(existing.projectPath) !== cwd) {
        throw new Error('Antigravity session belongs to another workspace.');
      }
      model = await context.resolveResumeModel(appId, readOptionalString(options.model))
        ?? (await context.getProviderModels()).DEFAULT;
      const credentials = readAntigravityCredentials();
      if (!(credentials.vertex ? credentials.project && credentials.location : credentials.apiKey)) {
        throw new Error('Google credentials are not configured. Run codey antigravity login.');
      }
      if (!(await context.isProviderInstalled())) {
        throw new Error('Google Antigravity SDK is not installed. Run codey antigravity install.');
      }
      const requestedEffort = readOptionalString(options.reasoningEffort) ?? readOptionalString(options.effort);
      // The shared composer sends "default" for the model's native setting.
      const effort = requestedEffort === 'default' ? undefined : requestedEffort;
      if (effort && !['minimal', 'low', 'medium', 'high', 'extra_high'].includes(effort)) {
        throw new Error(`Unsupported Google thinking level: ${effort}`);
      }
      const attachments = [
        ...normalizeAttachmentDescriptors(options.images),
        ...normalizeAttachmentDescriptors(options.files),
      ];
      const attachmentPaths = await Promise.all(attachments.map(async attachment => {
        const resolved = resolveImageAbsolutePath(cwd, attachment.path);
        if (!isAllowedImageSourcePath(resolved, cwd)) {
          throw new Error('Google attachments must be in the workspace or Codey upload store.');
        }
        const canonical = await realpath(resolved);
        if (!isAllowedImageSourcePath(canonical, cwd)) {
          throw new Error('Google attachments cannot link to files outside the allowed roots.');
        }
        return canonical;
      }));
      const child = dependencies.createBridge?.(cwd) ?? spawn(antigravityPython(), [antigravityBridge()], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      });
      const closed = new Promise<number | null>(resolve => {
        child.once('error', error => { reportError(error); resolve(null); });
        child.once('close', resolve);
      });
      turn = { child, closed, aborted: false };
      turns.set(key, turn);
      // Never log stderr: SDK diagnostics can contain request headers or keys.
      child.stderr.resume();
      child.stdin.on('error', error => { if (!turn?.aborted) reportError(error); });
      startupTimer = setTimeout(() => {
        reportError(new Error('Antigravity SDK did not start within 60 seconds.'));
        void stopChild(turn!, false);
      }, dependencies.startupTimeoutMs ?? 60_000);
      const mcp = await new AntigravityMcpProvider().listServers({ workspacePath: cwd });
      const servers = new Map([...mcp.user, ...mcp.project].map(server => [server.name, server]));
      child.stdin.write(JSON.stringify({
        prompt: command, cwd, model, effort, credentials,
        conversationId: nativeId, resume: Boolean(existing),
        stateDir: path.join(antigravitySessionStore.directory(nativeId), 'sdk'),
        permissionMode: readOptionalString(options.permissionMode) ?? 'default',
        attachments: attachmentPaths, mcpServers: [...servers.values()],
        skillsPaths: [path.join(cwd, '.agents', 'skills'), path.join(os.homedir(), '.agents', 'skills')].filter(existsSync),
        instructions: await workspaceInstructions(cwd),
      }) + '\n');
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (line.length > 16 * 1024 * 1024) throw new Error('Antigravity SDK event exceeds the size limit.');
        const event = readObjectRecord(JSON.parse(line));
        if (!event) throw new Error('Invalid Antigravity SDK event.');
        if (event.event === 'ready') {
          if (event.conversationId !== nativeId) throw new Error('Antigravity returned a different conversation ID.');
          clearTimeout(startupTimer);
          ready = true;
          if (!existing) await antigravitySessionStore.create({
            id: nativeId, projectPath: cwd, title: command.split('\n')[0].slice(0, 100),
            createdAt: new Date().toISOString(), model,
          });
          writer.setSessionId?.(nativeId);
          emit({ kind: 'session_created', newSessionId: nativeId });
          await antigravitySessionStore.setModel(nativeId, model);
          await record(createNormalizedMessage({
            kind: 'text', role: 'user', content: command,
            id: `${turnId}:user`, clientMessageId: readOptionalString(options.clientUserMessageId),
            provider, sessionId: key, images: options.images, files: options.files,
          }));
          await new AntigravitySessionSynchronizer().synchronizeFile(antigravitySessionStore.transcript(nativeId));
        } else if (event.event === 'permission') {
          const requestId = readOptionalString(event.requestId);
          if (!requestId || turn.aborted) continue;
          let input = event.input;
          if (event.question) {
            const questions = readObjectRecord(input)?.questions;
            input = { questions: Array.isArray(questions) ? questions.map(raw => {
              const question = readObjectRecord(raw) ?? {};
              return {
                question: question.question, header: 'Google',
                multiSelect: question.is_multi_select === true,
                options: Array.isArray(question.options) ? question.options.map(rawOption => {
                  const option = readObjectRecord(rawOption) ?? {};
                  return { label: option.text, description: '' };
                }) : [],
              };
            }) : [] };
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const pending: PendingPrompt = {
          requestId, sessionId: key, toolName: String(event.toolName), input,
          context: { canRemember: false }, receivedAt: new Date(),
            answer: decision => {
              if (!prompts.delete(requestId)) return;
              clearTimeout(timer);
              requestIds.delete(requestId);
              emit({ kind: 'permission_resolved', requestId });
              if (child.stdin.writable) child.stdin.write(JSON.stringify({ event: 'decision', requestId, ...decision }) + '\n');
            },
          };
          prompts.set(requestId, pending);
          requestIds.add(requestId);
          timer = setTimeout(() => pending.answer({ allow: false, message: 'Approval timed out.' }),
            dependencies.approvalTimeoutMs ?? (event.question ? 30 * 60_000 : 60_000));
        emit({ kind: 'permission_request', requestId, toolName: pending.toolName, input, context: pending.context });
        } else if (event.event === 'step') {
          const step = readObjectRecord(event.step) ?? {};
          const id = String(step.id || `${turnId}:${step.step_index}`);
          const state = texts.get(id) ?? { content: '', thinking: '' };
          if (typeof step.content_delta === 'string' && step.content_delta && step.source === 'MODEL' && step.target === 'TARGET_USER') {
            state.content += step.content_delta;
            emit({ kind: 'stream_delta', content: step.content_delta, model });
          }
          if (typeof step.thinking_delta === 'string' && step.thinking_delta) {
            state.thinking += step.thinking_delta;
          }
          texts.set(id, state);
          for (const raw of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
            const tool = readObjectRecord(raw) ?? {};
            const toolId = String(tool.id || `${id}:${tool.name}`);
            if (toolIds.has(toolId)) continue;
            toolIds.add(toolId);
            await record(emit({ kind: 'tool_use', id: `${toolId}:call`, toolId,
              toolName: String(tool.name), toolInput: tool.args }));
          }
          if (['DONE', 'ERROR', 'CANCELED'].includes(String(step.status)) && !recordedTexts.has(id)) {
            const content = step.source === 'MODEL' && step.target === 'TARGET_USER'
              ? String(step.content || state.content) : '';
            const thinking = String(step.thinking || state.thinking);
            if (thinking) await record(emit({ kind: 'thinking', id: `${id}:thinking`, content: thinking, model }));
            if (content) {
              // Text already streamed: persist the same response, do not append it twice live.
              if (!state.content) emit({ kind: 'stream_delta', content, model });
              emit({ kind: 'stream_end', model });
              await record(createNormalizedMessage({ kind: 'text', role: 'assistant',
                id, content, model, provider, sessionId: key }));
            }
            recordedTexts.add(id);
          }
          if (step.type === 'COMPACTION' && step.status === 'DONE') {
            await record(emit({ kind: 'text', role: 'assistant', content: String(step.content || 'Context compacted.'),
              compact: { phase: 'done' }, isCompactSummary: true }));
          }
          if (step.status === 'ERROR' && step.error) await record(emit({ kind: 'error', content: String(step.error) }));
        } else if (event.event === 'tool_result') {
          const result = readObjectRecord(event.result) ?? {};
          const toolId = String(result.id || `${result.step_id}:${result.name}`);
          await record(emit({ kind: 'tool_result', id: `${toolId}:result`, toolId,
            toolName: String(result.name), toolResult: { content: stringify(result.error || result.result), isError: Boolean(result.error) } }));
        } else if (event.event === 'error') {
          reportError(String(event.message || 'Antigravity SDK failed.'));
        } else if (event.event === 'result') {
          resultReceived = true;
          if (event.cancelled === true && !turn.aborted) {
            reportError(new Error('Antigravity SDK cancelled the turn before completion.'));
          }
          const usage = readObjectRecord(event.usage);
          if (usage) await record(emit({ kind: 'status', text: 'antigravity_usage', googleUsage: usage }));
          child.stdin.end();
        }
      }
      const exitCode = await closed;
      if (!turn.aborted && (exitCode !== 0 || !ready || !resultReceived)) {
        reportError(new Error(`Antigravity SDK ended without completing the turn (exit ${exitCode}).`));
      }
    } catch (error) {
      if (!turn?.aborted) reportError(error);
    } finally {
      clearTimeout(startupTimer);
      for (const id of requestIds) prompts.get(id)?.answer({ allow: false, message: 'Run ended.' });
      if (turn) {
        if (turn.child.exitCode === null && turn.child.signalCode === null) {
          await stopChild(turn, false);
        }
        turns.delete(key);
      }
      if (ready) {
        // Preserve an interrupted answer so a reload does not erase streamed work.
        for (const [id, text] of texts) {
          if (!recordedTexts.has(id) && text.content) {
            await record(createNormalizedMessage({
              id, provider, sessionId: key, kind: 'text', role: 'assistant', content: text.content, model,
            }));
          }
        }
      }
    }
    if (turn?.aborted) return; // The authenticated abort gateway owns the terminal event.
    emit(createCompleteMessage({ provider, sessionId: key, exitCode: failed ? 1 : 0 }));
    if (failed) throw new Error(failed);
  }

  return {
    run,
    canInterrupt: sessionId => turns.has(sessionId),
    abort(sessionId) {
      const turn = turns.get(sessionId);
      if (!turn) return false;
      turn.stopping ??= stopChild(turn);
      return turn.stopping;
    },
    permissions: {
      resolve: (requestId, decision) => prompts.get(requestId)?.answer(decision),
      listPending: sessionId => [...prompts.values()]
        .filter(prompt => prompt.sessionId === sessionId)
        .map(({ answer: _answer, ...prompt }) => prompt),
    },
  };
}

/** Registry runtime backed by the official Python SDK, with UI-owned tool approvals. */
export const antigravityRuntime = createAntigravityRuntime();
