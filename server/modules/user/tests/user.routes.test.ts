import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createUserRouter } from '../user.routes.js';
import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];
type DraftCall = [string, ...unknown[]];

const USER_ID = 7;

/** Serves the user routes over a service whose drafts store only records what it was asked to do. */
async function withUserServer(run: (baseUrl: string, calls: DraftCall[]) => Promise<void>): Promise<void> {
  const calls: DraftCall[] = [];
  const unexpected = () => {
    throw new Error('Unexpected user service call');
  };
  const dependencies: UserDependencies = {
    users: {
      getGitConfig: unexpected,
      updateGitConfig: unexpected,
      completeOnboarding: unexpected,
      hasCompletedOnboarding: unexpected,
    },
    preferences: { getPreferences: unexpected, savePreferences: unexpected },
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => { calls.push(['saveDraft', ...args]); },
      deleteDraft: (...args) => { calls.push(['deleteDraft', ...args]); },
    },
    readSystemGitConfig: unexpected,
    applyGlobalGitConfig: unexpected,
    logInfo: () => undefined,
    logError: () => undefined,
  };
  const service = createUserService(dependencies);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: USER_ID };
    next();
  });
  app.use('/api/user', createUserRouter(service));
  app.use((error: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ code: error.code });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const send = (url: string, method: string, body: unknown) => fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('PUT /drafts without a queued message writes only the text', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts`, 'PUT', { scope: 'session-a', text: 'typing' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['saveDraft', USER_ID, 'session-a', { text: 'typing' }]]);
  });
});
