import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProviderModelsDefinition } from '@/shared/types';
import { CODEY_MODEL_API_SETTINGS_CHANGED_EVENT } from '@/shared/constants';

const providerApiMocks = vi.hoisted(() => ({ models: vi.fn(), deleteModel: vi.fn(), capabilities: vi.fn() }));

const managedCodexModels: ProviderModelsDefinition = {
  DEFAULT: 'gpt-6.1-sol',
  OPTIONS: ['gpt-6.1-sol', 'gpt-6-astra'].map((value) => ({
    value,
    label: value,
    effort: {
      default: 'max',
      values: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ value: effort })),
    },
  })),
};

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: providerApiMocks.models,
      capabilities: providerApiMocks.capabilities,
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      deleteModel: providerApiMocks.deleteModel,
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  providerApiMocks.models.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  providerApiMocks.deleteModel.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  providerApiMocks.capabilities.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test('managed Claude model selection retains the Claude harness across new chats', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  const model = 'loki/claude-opus-5.5';
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: { models: provider === 'claude'
      ? { DEFAULT: model, OPTIONS: [{ value: model, label: 'Claude Opus 5.5' }], modelApiManaged: true }
      : managedCodexModels },
  }));
  writeUserPreference('selectedProvider', 'claude');
  const { result, unmount } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.provider, 'claude');
  assert.equal(result.current.currentProviderModel, model);
  assert.equal(result.current.providerModels.codex, 'gpt-6.1-sol');
  unmount();
  const restored = await renderProviderState();
  await waitFor(() => assert.equal(restored.result.current.providerModelsLoading, false));
  assert.equal(restored.result.current.provider, 'claude');
  assert.equal(restored.result.current.currentProviderModel, model);
});

test('saving proxy settings refreshes available models without changing the active harness', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  let enabled = false;
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: { models: provider === 'claude'
      ? { DEFAULT: enabled ? 'claude-opus-5.5' : '', OPTIONS: enabled ? [{ value: 'claude-opus-5.5', label: 'Claude Opus 5.5' }] : [], modelApiManaged: true }
      : managedCodexModels },
  }));
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.provider, 'codex');
  enabled = true;
  await act(async () => { window.dispatchEvent(new Event(CODEY_MODEL_API_SETTINGS_CHANGED_EVENT)); });
  await waitFor(() => assert.equal(result.current.providerModelCatalog.claude?.OPTIONS.length, 1));
  assert.equal(result.current.provider, 'codex');
  assert.equal(result.current.providerModels.claude, 'claude-opus-5.5');
});

test('managed chat offers Astra, persists its selection, and restores it for the next chat', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'codex' ? { models: managedCodexModels } : null,
  }));
  const { result, unmount } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.currentProviderModelOptions.length, 2);
  });
  assert.equal(result.current.currentProviderModel, 'gpt-6.1-sol');
  assert.deepEqual(result.current.currentProviderModelOptions.map(({ value }) => value), [
    'gpt-6.1-sol', 'gpt-6-astra',
  ]);

  await act(async () => {
    await result.current.selectProviderModel('codex', 'gpt-6-astra');
  });
  assert.equal(result.current.currentProviderModel, 'gpt-6-astra');
  assert.equal(localStorage.getItem('codex-model'), 'gpt-6-astra');
  assert.deepEqual(result.current.currentProviderEffortOptions.map(({ value }) => value), [
    'low', 'medium', 'high', 'xhigh', 'max',
  ]);

  unmount();
  const restored = await renderProviderState();
  await waitFor(() => {
    assert.equal(restored.result.current.providerModelsLoading, false);
  });
  assert.equal(restored.result.current.currentProviderModel, 'gpt-6-astra');
});

test('shared UI does not offer legacy Claude login models or Claude-in-Codex rows on old nodes', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  localStorage.setItem('claude-model', 'claude-opus-5.5');
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: { models: provider === 'claude'
      ? { DEFAULT: 'sonnet', OPTIONS: [{ value: 'sonnet', label: 'Sonnet' }, { value: 'claude-opus-5.5', label: 'Legacy custom Claude' }] }
      : { ...managedCodexModels, OPTIONS: [...managedCodexModels.OPTIONS, { value: 'loki/claude-opus-5.5', label: 'Wrong harness' }] } },
  }));
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.providerModelCatalog.claude, undefined);
  assert.equal(result.current.provider, 'codex');
  assert.equal(result.current.currentProviderModelOptions.length, 2);
  // Missing capabilities must not erase another node's remembered model.
  assert.equal(localStorage.getItem('claude-model'), 'claude-opus-5.5');
});

test('managed Claude preserves an unavailable explicit model instead of switching to another Claude model', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  localStorage.setItem('claude-model', 'claude-opus-5.5');
  writeUserPreference('selectedProvider', 'claude');
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'claude' ? {
      models: { DEFAULT: 'claude-other', OPTIONS: [{ value: 'claude-other', label: 'Other Claude' }], modelApiManaged: true },
    } : { models: managedCodexModels },
  }));
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.currentProviderModel, 'claude-opus-5.5');
  assert.equal(localStorage.getItem('claude-model'), 'claude-opus-5.5');
});

test('managed Claude migrates an old native default alias to the actual gateway default', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  localStorage.setItem('claude-model', 'default');
  writeUserPreference('selectedProvider', 'claude');
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'claude' ? {
      models: { DEFAULT: 'claude-opus-5.5', OPTIONS: [{ value: 'claude-opus-5.5', label: 'Claude Opus 5.5' }], modelApiManaged: true },
    } : { models: managedCodexModels },
  }));
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.currentProviderModel, 'claude-opus-5.5');
});

test('managed catalog hydration never replaces a saved model missing from the list', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  localStorage.setItem('codex-model', 'owner/unavailable');
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'codex' ? { models: managedCodexModels } : null,
  }));
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModelsLoading, false);
  });
  assert.equal(result.current.currentProviderModel, 'owner/unavailable');
  assert.equal(localStorage.getItem('codex-model'), 'owner/unavailable');
  await act(async () => {
    await result.current.selectProviderModel('codex', 'gpt-6.1-sol');
  });
  assert.equal(result.current.currentProviderModel, 'gpt-6.1-sol');
  assert.equal(localStorage.getItem('codex-model'), 'gpt-6.1-sol');
});

test('managed deletion never substitutes another model for the current selection', async () => {
  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  const custom = { value: 'owner/custom', label: 'Owner model', isCustom: true, recordId: 17 };
  localStorage.setItem('codex-model', custom.value);
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'codex'
      ? { models: { ...managedCodexModels, OPTIONS: [...managedCodexModels.OPTIONS, custom] } }
      : null,
  }));
  providerApiMocks.deleteModel.mockImplementation(() => okJson({
    success: true, data: { model: custom, models: managedCodexModels },
  }));
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.equal(result.current.currentProviderModelOptions.length, 3);
  });

  await act(async () => {
    await result.current.providerModelActions.remove('codex', custom);
  });
  await waitFor(() => {
    assert.equal(result.current.currentProviderModelOptions.length, 2);
  });
  assert.equal(result.current.currentProviderModel, custom.value);
  assert.equal(localStorage.getItem('codex-model'), custom.value);
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});

const capabilityRow = (provider: string, extra: Record<string, unknown> = {}) => ({
  provider, permissionModes: ['default'], defaultPermissionMode: 'default', supportsImages: true,
  supportsFiles: true, supportsAbort: true, supportsPermissionRequests: false, supportsTokenUsage: true, ...extra,
});

test('queued-message steering follows the node backend’s capability matrix', async () => {
  providerApiMocks.capabilities.mockImplementation(() => okJson({ success: true, data: { providers: [
    capabilityRow('claude', { supportsSteering: true }), capabilityRow('codex', { supportsSteering: true }),
    capabilityRow('cursor', { supportsSteering: false }),
  ] } }));
  writeUserPreference('selectedProvider', 'claude');
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.supportsSteering, true));
  act(() => result.current.setProvider('cursor'));
  assert.equal(result.current.supportsSteering, false);
});

test('a node backend that predates the steering capability keeps it Codex-only', async () => {
  providerApiMocks.capabilities.mockImplementation(() => okJson({ success: true, data: { providers: [
    capabilityRow('claude'), capabilityRow('codex'),
  ] } }));
  writeUserPreference('selectedProvider', 'claude');
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(providerApiMocks.capabilities.mock.calls.length > 0, true));
  await act(async () => {});
  assert.equal(result.current.supportsSteering, false);
  act(() => result.current.setProvider('codex'));
  assert.equal(result.current.supportsSteering, true);
});

test('a new Claude chat starts in the permission mode the node advertises as default', async () => {
  providerApiMocks.capabilities.mockImplementation(() => okJson({ success: true, data: { providers: [
    // Unlike the pre-load fallback list, this one has no 'auto', so its arrival is observable.
    capabilityRow('claude', {
      permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
      defaultPermissionMode: 'bypassPermissions',
    }),
    capabilityRow('codex'),
  ] } }));
  writeUserPreference('selectedProvider', 'claude');
  const { result, unmount } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  unmount();

  // A mode the user picked earlier still wins over the node's default.
  localStorage.setItem('permissionMode-last-claude', 'default');
  const remembered = await renderProviderState();
  await waitFor(() => assert.equal(remembered.result.current.availablePermissionModes.includes('auto'), false));
  assert.equal(remembered.result.current.permissionMode, 'default');
});

test('a managed node names the effort "Default" runs at; other installs leave it to the CLI', async () => {
  const model = 'claude-opus-5.5';
  const claudeModels = {
    DEFAULT: model, modelApiManaged: true,
    OPTIONS: [{ value: model, label: 'Claude Opus 5.5', effort: { default: 'max', values: [{ value: 'high' }, { value: 'max' }] } }],
  };
  providerApiMocks.models.mockImplementation((provider: string) => okJson({
    success: true, data: { models: provider === 'claude' ? claudeModels : managedCodexModels },
  }));
  writeUserPreference('selectedProvider', 'claude');
  localStorage.setItem('claude-model', model);

  const unmanaged = await renderProviderState();
  await waitFor(() => assert.equal(unmanaged.result.current.providerModelsLoading, false));
  assert.equal(unmanaged.result.current.currentProviderEffort, 'default');
  assert.equal(unmanaged.result.current.currentProviderDefaultEffort, null);
  unmanaged.unmount();
  vi.resetModules();

  vi.stubEnv('VITE_CODEY_MANAGED', 'true');
  const managed = await renderProviderState();
  await waitFor(() => assert.equal(managed.result.current.providerModelsLoading, false));
  assert.equal(managed.result.current.currentProviderEffort, 'default');
  assert.equal(managed.result.current.currentProviderDefaultEffort, 'max');
});
