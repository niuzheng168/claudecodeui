import type { RequestHandler } from 'express';

import { userDb } from '@/modules/database/index.js';

import { createPortalSsoService } from './portal-sso.service.js';

/** Shared within Auth's HTTP/JWT adapters and WebSocket composition. */
export const portalSso = createPortalSsoService({
  environment: process.env,
  users: {
    first: () => userDb.getFirstUser(),
    hasUsers: () => userDb.hasUsers(),
    create: (username, passwordHash) => userDb.createUser(username, passwordHash),
    completeOnboarding: (id) => userDb.completeOnboarding(id),
  },
});

/** Mounted FIRST by the server entrypoint; protects assets and every API alike. */
export const portalSsoMiddleware: RequestHandler = (req, res, next) => {
  if (!portalSso.enabled || (req.method === 'GET' && req.url === '/health')) {
    next();
    return;
  }
  const user = portalSso.authenticate(req);
  if (!user) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Auth-Error', 'session-expired');
    res.status(401).json({ error: 'Codey portal authentication required', code: 'AUTH_TOKEN_EXPIRED' });
    return;
  }
  Object.assign(req, { user });
  next();
};

/** Used by WebSocket composition; absent outside strict Codey SSO mode. */
export const authenticatePortalWebSocket = portalSso.enabled ? portalSso.authenticate : undefined;
