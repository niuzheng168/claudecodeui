import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('upgrading the model library preserves old IDs/effort and allows Google models idempotently', () => {
  const database = new Database(':memory:');
  try {
    database.exec(INIT_SCHEMA_SQL.replace(", 'antigravity'", ''));
    database.prepare(`
      INSERT INTO provider_models (id, provider, model_id, model_name, sort_order, effort_values, effort_default)
      VALUES (42, 'codex', 'existing-model', 'Existing', 7, '["low","high"]', 'high')
    `).run();
    const before = database.prepare('SELECT * FROM provider_models WHERE id = 42').get();
    runMigrations(database);
    runMigrations(database);
    assert.deepEqual(database.prepare('SELECT * FROM provider_models WHERE id = 42').get(), before);
    const inserted = database.prepare(`
      INSERT INTO provider_models (provider, model_id, model_name)
      VALUES ('antigravity', 'gemini-custom', 'Custom Google')
    `).run();
    assert.ok(Number(inserted.lastInsertRowid) > 42);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_provider_models_provider_order'").get());
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'provider_models_before_antigravity'").get(), undefined);
  } finally { database.close(); }
});
