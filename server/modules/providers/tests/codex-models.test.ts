import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  CODEX_PREDEFINED_MODELS,
  CODEY_MANAGED_CODEX_MODELS,
  resolveCodexPredefinedModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('ordinary CloudCLI keeps its full Codex model catalog', () => {
  assert.equal(resolveCodexPredefinedModels(false), CODEX_PREDEFINED_MODELS);
  assert.ok(CODEX_PREDEFINED_MODELS.OPTIONS.length > 1);
});

test('Codey-managed nodes expose the current upstream model ID and context', () => {
  const catalog = resolveCodexPredefinedModels(true);

  assert.equal(catalog, CODEY_MANAGED_CODEX_MODELS);
  assert.equal(catalog.DEFAULT, 'gpt-6.1-sol');
  assert.deepEqual(
    catalog.OPTIONS.map(({ value, label }) => ({ value, label })),
    [
      { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (922K context)' },
      { value: 'gpt-6-astra', label: 'GPT-6 Astra (872K context)' },
    ],
  );
  for (const option of catalog.OPTIONS) {
    assert.equal(option.effort?.default, 'max');
    assert.deepEqual(
      option.effort?.values.map(({ value }) => value),
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
  }
});

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('the ordinary and managed Codex catalogs each list a model once', () => {
  for (const catalog of [CODEX_PREDEFINED_MODELS, CODEY_MANAGED_CODEX_MODELS]) {
    const values = catalog.OPTIONS.map(({ value }) => value);
    assert.deepEqual(values, [...new Set(values)]);
    assert.ok(values.includes(catalog.DEFAULT));
  }
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});
