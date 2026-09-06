import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from '../services/websocket-auth.service.js';

test('Codey WebSocket verification never falls back to platform or JWT auth', () => {
  const info = { origin: 'https://codey.test', secure: true, req: { url: '/shell?token=old-jwt', headers: {} } };
  let legacyCalled = false;
  const dependencies = {
    isPlatform: true,
    authenticatePortalRequest: () => null,
    authenticateWebSocket: () => { legacyCalled = true; return { id: 99 }; },
  };
  assert.equal(verifyWebSocketClient(info as Parameters<typeof verifyWebSocketClient>[0], dependencies), false);
  assert.equal(legacyCalled, false);
  const valid = { ...dependencies, authenticatePortalRequest: () => ({ id: 1, userId: 1, username: 'zhn' }) };
  assert.equal(verifyWebSocketClient(info as Parameters<typeof verifyWebSocketClient>[0], valid), true);
  assert.equal(legacyCalled, false);
});
