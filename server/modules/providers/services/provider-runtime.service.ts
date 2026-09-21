import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { codexSessionTitleService } from '@/modules/providers/list/codex/codex-session-title.service.js';
import { AppError, readObjectRecord } from '@/shared/index.js';
import type {
  AnyRecord,
  IProvider,
  LLMProvider,
  NewCodexSessionTitleRequest,
  ProviderPermissionDecision,
  ProviderAbortOptions,
  ProviderRuntimeObservation,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/index.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  scheduleTitle(input: NewCodexSessionTitleRequest): Promise<void>;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  scheduleTitle: input => codexSessionTitleService.schedule(input),
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    if (providerName !== 'codex' || !sessionId || dependencies.resolveProviderSessionId(sessionId)) {
      return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
    }

    let scheduled = false;
    const schedule = (providerSessionId: unknown): void => {
      if (scheduled || typeof providerSessionId !== 'string' || !providerSessionId) return;
      scheduled = true;
      try {
        // The original writer persists the native ID first. Naming runs on
        // its own metadata connection and never delays chat/queue completion.
        void dependencies.scheduleTitle({ sessionId, providerSessionId, initialMessage: command }).catch(() => {});
      } catch { /* Metadata generation cannot fail the provider's user turn. */ }
    };
    const namingWriter: ProviderRuntimeWriter = {
      userId: writer.userId,
      isWebSocketWriter: writer.isWebSocketWriter,
      isSSEStreamWriter: writer.isSSEStreamWriter,
      setSessionId: id => {
        writer.setSessionId?.(id);
        schedule(id);
      },
      send: value => {
        writer.send(value);
        if (scheduled) return;
        let message: AnyRecord | null = null;
        try { message = readObjectRecord(typeof value === 'string' ? JSON.parse(value) : value); } catch { /* Preserve non-JSON output. */ }
        if (message?.kind === 'session_created') schedule(message.newSessionId || message.sessionId);
      },
    };
    return provider.runtime.run(command, options, namingWriter, createRuntimeContext(provider));
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string, options?: ProviderAbortOptions): Promise<boolean> {
      const runtime = dependencies.resolveProvider(providerName).runtime;
      return Boolean(await (options ? runtime.abort(sessionId, options) : runtime.abort(sessionId)));
    },

    canInterrupt(providerName: LLMProvider, sessionId: string): boolean {
      return dependencies.resolveProvider(providerName).runtime.canInterrupt?.(sessionId) ?? true;
    },

    async prepareObservation(providerName: LLMProvider, sessionId: string): Promise<ProviderRuntimeObservation | null> {
      const provider = dependencies.resolveProvider(providerName);
      return provider.runtime.prepareObservation?.(sessionId, createRuntimeContext(provider)) ?? null;
    },

    canSteer(providerName: LLMProvider, sessionId: string): boolean {
      return dependencies.resolveProvider(providerName).runtime.canSteer?.(sessionId) === true;
    },

    async steer(providerName: LLMProvider, sessionId: string, command: string, options: AnyRecord): Promise<void> {
      const runtime = dependencies.resolveProvider(providerName).runtime;
      if (!runtime.steer) {
        throw new AppError('This runtime does not support steering. Queue the message instead.', {
          code: 'STEER_UNSUPPORTED', statusCode: 409,
        });
      }
      await runtime.steer(sessionId, command, options);
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

/** WebSocket and provider routes use the registry-backed runtime dispatcher. */
export const providerRuntimeService = createProviderRuntimeService();
