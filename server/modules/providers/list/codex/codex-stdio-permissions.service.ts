import { randomUUID } from 'node:crypto';

import { AppError, createNormalizedMessage, readObjectRecord } from '@/shared/index.js';
import type {
  AnyRecord, CodexRpcRequestId, ICodexRpcClient, ProviderPermissionDecision,
  ProviderRuntimePermissionGateway, ProviderRuntimeWriter,
} from '@/shared/index.js';

type Approval = {
  sessionId: string;
  client: ICodexRpcClient;
  nativeId: CodexRpcRequestId;
  method: string;
  params: AnyRecord;
  publicRequest: AnyRecord;
  writer: ProviderRuntimeWriter;
  timer: ReturnType<typeof setTimeout>;
};

function emit(writer: ProviderRuntimeWriter, value: AnyRecord): void {
  try {
    writer.send(writer.isSSEStreamWriter || writer.isWebSocketWriter ? value : JSON.stringify(value));
  } catch { /* Reconnection replays the pending request through listPending. */ }
}

/**
 * Used by CodexSharedRuntime only for its own stdio child, never the desktop
 * owner's daemon. Decisions apply once to the displayed request; edited input
 * and persistent policy amendments cannot silently expand an approval.
 */
export class CodexStdioPermissions {
  private readonly pending = new Map<string, Approval>();
  readonly gateway: ProviderRuntimePermissionGateway = {
    resolve: (id, decision) => this.resolve(id, decision),
    listPending: (sessionId) => [...this.pending.values()]
      .filter((item) => item.sessionId === sessionId).map((item) => item.publicRequest),
  };

  handle(
    client: ICodexRpcClient, sessionId: string, threadId: string, method: string,
    params: AnyRecord, nativeId: CodexRpcRequestId | undefined, writer: ProviderRuntimeWriter,
  ): void {
    if (!client.ownsProcess || !client.respondToServerRequest || nativeId === undefined) return;
    if (params.threadId !== threadId) {
      client.respondToServerRequest(nativeId, {
        error: { code: -32602, message: 'This interaction does not belong to the active Codey run.' },
      });
      return;
    }
    const toolNames: Record<string, string> = {
      'item/commandExecution/requestApproval': 'Bash',
      'item/fileChange/requestApproval': 'Edit',
      'item/permissions/requestApproval': 'Codex permissions',
    };
    const questions = method === 'item/tool/requestUserInput' && Array.isArray(params.questions)
      && params.questions.length > 0 && params.questions.length <= 10
      && params.questions.every((question: AnyRecord) => question && typeof question.id === 'string'
        && typeof question.question === 'string' && question.id.length > 0
        && (question.options === null || Array.isArray(question.options)))
      && new Set(params.questions.map((question: AnyRecord) => question.id)).size === params.questions.length
      ? params.questions as AnyRecord[] : null;
    const toolName = questions ? 'AskUserQuestion' : toolNames[method];
    if (!toolName) {
      client.respondToServerRequest(nativeId, {
        error: { code: -32601, message: 'This interaction is not available or has an invalid payload in the Codey native runtime.' },
      });
      emit(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'task_notification', status: 'info',
        summary: `The native runtime cannot handle ${method}; it did not grant permission or leave the request waiting for an unavailable desktop client.`,
      }));
      return;
    }
    const requestId = `codex-${randomUUID()}`;
    const input = questions ? {
      questions: questions.map((question) => ({
        id: question.id, header: question.header, question: question.question,
        options: question.options ?? [], multiSelect: false,
        isSecret: question.isSecret === true, allowOther: question.isOther !== false,
      })),
    } : params;
    const publicRequest = { requestId, toolName, input, sessionId, provider: 'codex' as const };
    const timer = setTimeout(() => this.resolve(requestId, { allow: false }), 5 * 60_000);
    this.pending.set(requestId, { sessionId, client, nativeId, method, params, publicRequest, writer, timer });
    emit(writer, createNormalizedMessage({ ...publicRequest, kind: 'permission_request' }));
  }

  cancel(sessionId: string, client: ICodexRpcClient): void {
    for (const [id, item] of this.pending) {
      if (item.sessionId !== sessionId || item.client !== client) continue;
      clearTimeout(item.timer);
      this.pending.delete(id);
      emit(item.writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'permission_cancelled', requestId: id, reason: 'turn_ended',
      }));
    }
  }

  /** Used by the native runtime when Codex resolves a timed/nonblocking question before the user answers. */
  resolvedByNative(client: ICodexRpcClient, nativeId: CodexRpcRequestId): void {
    for (const [id, item] of this.pending) {
      if (item.client !== client || item.nativeId !== nativeId) continue;
      clearTimeout(item.timer);
      this.pending.delete(id);
      emit(item.writer, createNormalizedMessage({
        provider: 'codex', sessionId: item.sessionId, kind: 'permission_resolved', requestId: id,
      }));
    }
  }

  private resolve(id: string, decision: ProviderPermissionDecision): void {
    const item = this.pending.get(id);
    if (!item) return;
    const isQuestion = item.method === 'item/tool/requestUserInput';
    if ((!isQuestion && decision.updatedInput != null) || decision.rememberEntry != null) {
      throw new AppError('Native Codex approvals apply once to the displayed request; edited input or remembered grants are not supported.', {
        code: 'CODEX_APPROVAL_EDIT_UNSUPPORTED', statusCode: 400,
      });
    }
    let questionAnswers: AnyRecord = {};
    if (isQuestion && decision.allow) {
      const answers = readObjectRecord(readObjectRecord(decision.updatedInput)?.answers);
      const questions = item.params.questions as AnyRecord[];
      if (!answers || Object.entries(answers).some(([key, value]) =>
        !questions.some((question) => question.id === key) || typeof value !== 'string' || value.length > 20_000)) {
        throw new AppError('Answers must reference the displayed question ids and contain only text.', {
          code: 'CODEX_QUESTION_ANSWERS_INVALID', statusCode: 400,
        });
      }
      questionAnswers = Object.fromEntries(questions.flatMap((question) =>
        typeof answers[question.id] === 'string' ? [[question.id, { answers: [answers[question.id]] }]] : []));
    }
    clearTimeout(item.timer);
    this.pending.delete(id);
    item.client.respondToServerRequest?.(item.nativeId, {
      result: isQuestion ? { answers: questionAnswers } : item.method === 'item/permissions/requestApproval'
        ? { permissions: decision.allow === true ? item.params.permissions : {}, scope: 'turn' }
        : { decision: decision.allow === true ? 'accept' : 'decline' },
    });
    emit(item.writer, createNormalizedMessage({
      provider: 'codex', sessionId: item.sessionId, kind: 'permission_resolved', requestId: id,
    }));
  }
}
