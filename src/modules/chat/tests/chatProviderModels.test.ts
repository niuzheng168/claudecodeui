import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProviderModelsDefinition } from '@/shared/types';

const providerApiMocks = vi.hoisted(() => ({ models: vi.fn() }));

const managedCodexModels: ProviderModelsDefinition = {
  DEFAULT: 'gpt-6.1-sol',
  OPTIONS: ['gpt-6.1-sol', 'codex/gpt-6-astra'].map((value) => ({
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
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
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
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
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
    'gpt-6.1-sol', 'codex/gpt-6-astra',
  ]);

  await act(async () => {
    await result.current.selectProviderModel('codex', 'codex/gpt-6-astra');
  });
  assert.equal(result.current.currentProviderModel, 'codex/gpt-6-astra');
  assert.equal(localStorage.getItem('codex-model'), 'codex/gpt-6-astra');
  assert.deepEqual(result.current.currentProviderEffortOptions.map(({ value }) => value), [
    'low', 'medium', 'high', 'xhigh', 'max',
  ]);

  unmount();
  const restored = await renderProviderState();
  await waitFor(() => {
    assert.equal(restored.result.current.providerModelsLoading, false);
  });
  assert.equal(restored.result.current.currentProviderModel, 'codex/gpt-6-astra');
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
