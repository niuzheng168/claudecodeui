import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import { createPortalSsoService } from '../portal-sso.service.js';

const key = randomBytes(32).toString('base64url');
const now = 2_000_000_000;
const environment = {
  CODEY_PORTAL_SSO: 'true',
  CODEY_PORTAL_NODE_ID: 'node-a',
  CODEY_PORTAL_USERNAME: 'zhn',
  CODEY_PORTAL_PRINCIPAL_ID: 'owner-one',
  CODEY_PORTAL_SSO_KEY: key,
};
function assertion(overrides: Record<string, unknown> = {}, signingKey = key): string {
  const body = Buffer.from(JSON.stringify({
    iss: 'codey-portal', aud: 'node-a', sub: 'owner-one', username: 'zhn',
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
      create: () => { created = true; return { id: 1, username: 'zhn' }; }, completeOnboarding: () => {},
    },
  });
  const req = request(assertion());
  assert.deepEqual(service.authenticate(req), { id: 7, userId: 7, username: 'zhn' });
  assert.equal(service.authenticatedUser(req)?.id, 7);
  assert.equal(created, false);
  assert.equal(service.authenticatedUser(request()), null);
});

test('forged, expired, wrong-node/user/path/method assertions and local JWTs all fail closed', () => {
  const service = createPortalSsoService({
    environment, clock: () => now * 1000,
    users: { first: () => ({ id: 1, username: 'zhn' }), hasUsers: () => true, create: () => { throw new Error('unexpected create'); }, completeOnboarding: () => {} },
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
  assert.equal(service.authenticate(request(assertion()))?.username, 'zhn');
  assert.equal(completed, true);
});

test('SSO configuration cannot silently fall back when its secret is missing', () => {
  const users = { first: () => undefined, hasUsers: () => false, create: () => ({ id: 1, username: 'zhn' }), completeOnboarding: () => {} };
  assert.throws(() => createPortalSsoService({ environment: { ...environment, CODEY_PORTAL_SSO_KEY: '' }, users }), /requires a node key/);
  assert.equal(createPortalSsoService({ environment: {}, users }).enabled, false);
});
