import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createUserService } from '../user.service.js';
import { createUserRouter } from '../user.routes.js';

type UserDependencies = Parameters<typeof createUserService>[0];

function createDependencies(overrides: Partial<UserDependencies> = {}): UserDependencies {
  return {
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: () => undefined,
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    preferences: {
      getPreferences: () => ({}),
      savePreferences: () => undefined,
    },
    drafts: {
      getDrafts: () => [],
      saveDraft: () => undefined,
      deleteDraft: () => undefined,
    },
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('getGitConfig imports system configuration when the repository is empty', async () => {
  const updates: unknown[][] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (...args) => updates.push(args),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => ({ git_name: 'Alice', git_email: 'alice@example.com' }),
  }));

  const result = await service.getGitConfig(7);

  assert.equal(result.gitName, 'Alice');
  assert.deepEqual(updates, [[7, 'Alice', 'alice@example.com']]);
});

test('updateGitConfig persists valid input and invokes the Git adapter', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    applyGlobalGitConfig: async (name, email) => {
      operations.push(`git:${name}:${email}`);
    },
  }));

  await service.updateGitConfig(1, 'Alice', 'alice@example.com');
  assert.deepEqual(operations, [
    'persist:Alice:alice@example.com',
    'git:Alice:alice@example.com',
  ]);
});

test('savePreferences forwards only the keys the client sent', () => {
  const saved: Array<Record<string, unknown>> = [];
  const service = createUserService(createDependencies({
    preferences: {
      getPreferences: () => ({ theme: 'dark' }),
      savePreferences: (_id, updates) => saved.push(updates),
    },
  }));

  const result = service.savePreferences(3, { theme: 'light' });

  assert.deepEqual(saved, [{ theme: 'light' }]);
  assert.deepEqual(result.preferences, { theme: 'dark' });
});

test('savePreferences rejects a non-object body', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, ['theme']), /object/i);
  assert.throws(() => service.savePreferences(3, 'theme'), /object/i);
});

test('savePreferences rejects an over-long preference key', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, { ['k'.repeat(201)]: 1 }), /1-200/);
});

test('saveDraft stores the text and queued message under the given scope', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => saved.push(args),
      deleteDraft: () => undefined,
    },
  }));

  service.saveDraft(5, 'session-1', {
    scope: 'session-1',
    text: 'half a thought',
    queuedMessage: { content: 'later' },
  });

  assert.deepEqual(saved, [[5, 'session-1', {
    text: 'half a thought',
    queuedMessage: { content: 'later' },
  }]]);
});

test('saveDraft defaults a missing queued message to null rather than dropping the row', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => saved.push(args),
      deleteDraft: () => undefined,
    },
  }));

  service.saveDraft(5, 'session-1', { scope: 'session-1', text: 'typing' });

  assert.deepEqual(saved, [[5, 'session-1', { text: 'typing', queuedMessage: null }]]);
});

test('saveDraft rejects a blank or over-long scope', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.saveDraft(5, '   ', { text: 'x' }), /scope/i);
  assert.throws(() => service.saveDraft(5, 'x'.repeat(201), { text: 'x' }), /scope/i);
});

test('saveDraft rejects text past the storage limit', () => {
  const service = createUserService(createDependencies());

  assert.throws(
    () => service.saveDraft(5, 'session-1', { text: 'x'.repeat(100_001) }),
    /too long/i,
  );
});

test('text-only draft saves opt out of replacing the server-owned queue', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: { getDrafts: () => [], saveDraft: (...args) => saved.push(args), deleteDraft: () => {} },
  }));
  service.saveDraft(5, 'session-1', { text: 'typing', queuedMessage: { content: 'stale snapshot' }, preserveQueuedMessage: true });
  service.saveDraft(5, 'session-1', { text: '', queuedMessage: null, preserveQueuedMessage: true });
  assert.deepEqual(saved, [[5, 'session-1', { text: 'typing' }], [5, 'session-1', { text: '' }]]);
});

test('queued steering delegates with the authenticated user and validated scope, not body overrides', async () => {
  const calls: unknown[][] = [];
  const service = createUserService(createDependencies({
    steerQueuedDraft: async (...args) => { calls.push(args); return { accepted: true }; },
  }));
  const queuedMessage = { id: 'queue-1', content: 'append this' };
  assert.deepEqual(await service.steerQueuedDraft(5, 'session-1', {
    userId: 99, sessionId: 'forged-session', requestId: 'r', expectedRunId: 'run', queuedMessage,
  }), { accepted: true });
  assert.deepEqual(calls, [[5, {
    userId: 99, sessionId: 'session-1', requestId: 'r', expectedRunId: 'run', queuedMessage,
  }]]);
  await assert.rejects(service.steerQueuedDraft(5, '', {}), /scope/i);
  assert.equal(calls.length, 1);
});

test('an unconfigured queued transport rejects without mutating the queue', async () => {
  const service = createUserService(createDependencies());
  await assert.rejects(service.steerQueuedDraft(5, 'session-1', {}), (error: Error & { code?: string }) => error.code === 'STEER_UNSUPPORTED');
});

test('POST drafts/steer returns its correlated result and forwards scope validation errors', async (t) => {
  const calls: unknown[][] = [];
  const service = createUserService(createDependencies({
    steerQueuedDraft: async (userId, input) => {
      calls.push([userId, input]);
      return { kind: 'chat_steer_result', requestId: 'r', sessionId: 'session-1', accepted: true };
    },
  }));
  const app = express();
  app.use(express.json(), (request, _response, next) => {
    Object.assign(request, { user: { id: 5 } });
    next();
  });
  app.use('/api/user', createUserRouter(service));
  const errors: express.ErrorRequestHandler = (error, _request, response, _next) => {
    response.status(error.statusCode ?? 500).json({ code: error.code });
  };
  app.use(errors);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/user/drafts/steer`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'session-1', requestId: 'r', queuedMessage: { id: 'q', content: 'queued' } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'chat_steer_result', requestId: 'r', sessionId: 'session-1', accepted: true });
  assert.equal(calls[0][0], 5);
  const invalid = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: '' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1);
});
