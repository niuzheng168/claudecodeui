import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_PREDEFINED_MODELS,
  CODEY_MANAGED_CODEX_MODELS,
  resolveCodexPredefinedModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

test('ordinary CloudCLI keeps its full Codex model catalog', () => {
  assert.equal(resolveCodexPredefinedModels(false), CODEX_PREDEFINED_MODELS);
  assert.ok(CODEX_PREDEFINED_MODELS.OPTIONS.length > 1);
});

test('Codey-managed nodes expose only GPT-6 Astra with its 872K context label', () => {
  const catalog = resolveCodexPredefinedModels(true);

  assert.equal(catalog, CODEY_MANAGED_CODEX_MODELS);
  assert.equal(catalog.DEFAULT, 'gpt-6-astra');
  assert.deepEqual(
    catalog.OPTIONS.map(({ value, label }) => ({ value, label })),
    [{
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra (872K context)',
    }],
  );
  assert.deepEqual(
    catalog.OPTIONS[0]?.effort?.values.map(({ value }) => value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});
