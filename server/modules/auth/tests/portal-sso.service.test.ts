import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { createAzureDevOpsRoutes } from '@/modules/azure-devops/index.js';

import { createPortalSsoService } from '../portal-sso.service.js';

const key = randomBytes(32).toString('base64url');
const now = 2_000_000_000;
const environment = {
  CODEY_PORTAL_SSO: 'true',
  CODEY_PORTAL_NODE_ID: 'node-a',
  CODEY_PORTAL_USERNAME: 'operator',
  CODEY_PORTAL_PRINCIPAL_ID: 'owner-one',
  CODEY_PORTAL_SSO_KEY: key,
};
function assertion(overrides: Record<string, unknown> = {}, signingKey = key): string {
  const body = Buffer.from(JSON.stringify({
    iss: 'codey-portal', aud: 'node-a', sub: 'owner-one', username: 'operator',
    sid: 'f'.repeat(64), method: 'GET', path: '/api/projects?q=1',
    iat: now, exp: now + 20, nonce: randomBytes(16).toString('base64url'), ...overrides,
  })).toString('base64url');
  return `${body}.${createHmac('sha256', Buffer.from(signingKey, 'base64url')).update(body).digest('base64url')}`;
}
const request = (token?: string) => ({
  method: 'GET', url: '/api/projects?q=1',
  headers: token ? { 'x-codey-workspace-assertion': token } : {},
}) as unknown as IncomingMessage;

test('valid SSO preserves the existing database user ID without copying credentials', () => {
  let created = false;
  const service = createPortalSsoService({
    environment, clock: () => now * 1000,
    users: {
      first: () => ({ id: 7, username: 'old-local-name' }), hasUsers: () => true,
      create: () => { created = true; return { id: 1, username: 'operator' }; }, completeOnboarding: () => {},
    },
  });
  const req = request(assertion());
  assert.deepEqual(service.authenticate(req), { id: 7, userId: 7, username: 'operator' });
  assert.equal(service.authenticatedUser(req)?.id, 7);
  assert.equal(created, false);
  assert.equal(service.authenticatedUser(request()), null);
});

test('forged, expired, wrong-node/user/path/method assertions and local JWTs all fail closed', () => {
  const service = createPortalSsoService({
    environment, clock: () => now * 1000,
    users: { first: () => ({ id: 1, username: 'operator' }), hasUsers: () => true, create: () => { throw new Error('unexpected create'); }, completeOnboarding: () => {} },
  });
  for (const overrides of [
    { aud: 'node-b' }, { sub: 'owner-two' }, { username: 'admin' },
    { method: 'POST' }, { path: '/api/git' }, { exp: now }, { exp: now + 600 },
    { iat: now + 10, exp: now + 20 }, { iss: 'attacker' }, { sid: 'bad' }, { nonce: 'bad' },
  ]) assert.equal(service.authenticate(request(assertion(overrides))), null);
  assert.equal(service.authenticate(request(assertion({}, randomBytes(32).toString('base64url')))), null);
  assert.equal(service.authenticate(request('unsigned')), null);
  assert.equal(service.authenticate(request()), null);
  const jwtReq = request();
  jwtReq.headers.authorization = 'Bearer formerly-valid-jwt';
  jwtReq.headers.cookie = 'session=old';
  jwtReq.headers['x-ms-client-principal-id'] = 'owner-one';
  assert.equal(service.authenticate(jwtReq), null);
  const replay = assertion();
  assert.ok(service.authenticate(request(replay)));
  assert.equal(service.authenticate(request(replay)), null);
});

test('empty nodes create only a gateway-bound identity after valid authentication', () => {
  let user: { id: number; username: string } | undefined;
  let completed = false;
  const service = createPortalSsoService({
    environment, clock: () => now * 1000,
    users: {
      first: () => user, hasUsers: () => Boolean(user),
      create: (username, hash) => {
        assert.match(hash, /^!codey-sso-only:/);
        user = { id: 1, username };
        return user;
      },
      completeOnboarding: () => { completed = true; },
    },
  });
  assert.equal(service.authenticate(request()), null);
  assert.equal(user, undefined);
  assert.equal(service.authenticate(request(assertion()))?.username, 'operator');
  assert.equal(completed, true);
});

test('SSO configuration cannot silently fall back when its secret is missing', () => {
  const users = { first: () => undefined, hasUsers: () => false, create: () => ({ id: 1, username: 'operator' }), completeOnboarding: () => {} };
  assert.throws(() => createPortalSsoService({ environment: { ...environment, CODEY_PORTAL_SSO_KEY: '' }, users }), /requires a node key/);
  assert.equal(createPortalSsoService({ environment: {}, users }).enabled, false);
});

test('memory uses only the signed account namespace, never the machine-local subject or an owner header',()=>{
  const service=createPortalSsoService({
    environment,clock:()=>now*1000,
    users:{first:()=>({id:1,username:'operator'}),hasUsers:()=>true,create:()=>{throw new Error('unexpected');},completeOnboarding:()=>{}},
  });
  const path='/api/codey/memory/projects/p-aaaaaaaaaaaaaaaa/memory?cursor=100&revision=4';
  const verified=request(assertion({path,memory_account:'stable-account'}));verified.url=path;
  assert.ok(service.authenticate(verified));
  assert.equal(service.authenticatedMemoryAccount(verified),'stable-account');
  const missing=request(assertion({path}));missing.url=path;missing.headers['x-memory-account']='forged-owner';
  assert.ok(service.authenticate(missing));
  assert.equal(service.authenticatedMemoryAccount(missing),null);
  const invalid=request(assertion({path,memory_account:'../escape'}));invalid.url=path;
  assert.ok(service.authenticate(invalid));assert.equal(service.authenticatedMemoryAccount(invalid),null);
  const ordinary=request(assertion({memory_account:'stable-account'}));
  assert.ok(service.authenticate(ordinary));assert.equal(service.authenticatedMemoryAccount(ordinary),null);
});

test('ADO accepts request-bound owner SSO without a memory-only claim; forged owners and replay still fail', async t => {
  const sso = createPortalSsoService({
    environment, clock: () => now * 1000,
    users: {
      first: () => ({ id: 7, username: 'operator' }), hasUsers: () => true,
      create: () => { throw new Error('unexpected create'); }, completeOnboarding: () => {},
    },
  });
  let calls = 0;
  const service = {
    read: async () => {
      calls++;
      return { contract: 1, title: 'Example', queryType: 'item', items: [], columns: [], relations: [], missingIds: [], truncated: false, fetchedAt: new Date().toISOString() };
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    sso.authenticate(req);
    // An attacker-controlled user/header must not become the trusted owner mark.
    Object.assign(req, { user: { username: 'operator' } });
    next();
  });
  app.use('/api/codey/azure-devops', createAzureDevOpsRoutes(service, req => {
    assert.equal(sso.authenticatedMemoryAccount(req), null);
    return sso.authenticatedUser(req) !== null;
  }));
  app.use(((error, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ code: error.code });
  }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const route = '/api/codey/azure-devops/read';
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${route}`;
  const post = (token?: string) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-memory-account': 'forged-owner',
      ...(token ? { 'x-codey-workspace-assertion': token } : {}) },
    body: JSON.stringify({ organization: 'example-org', project: 'Example', kind: 'item', id: '123' }),
  });
  for (const token of [undefined, 'unsigned',
    assertion({ method: 'POST', path: route, sub: 'other-owner' }),
    assertion({ method: 'POST', path: route, aud: 'other-node' }),
    assertion({ method: 'GET', path: route }),
    assertion({ method: 'POST', path: '/api/projects' }),
  ]) assert.equal((await post(token)).status, 403);
  assert.equal(calls, 0);
  const valid = assertion({ method: 'POST', path: route });
  assert.equal((await post(valid)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post(valid)).status, 403);
  assert.equal(calls, 1);
});
