import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  portalSsoEnabled = false,
): express.Router {
  const router = express.Router();
  if (portalSsoEnabled) router.use(authenticateToken);

  router.use((req, res, next) => {
    if (portalSsoEnabled && !(req.method === 'GET' && ['/status', '/user'].includes(req.path))) {
      res.status(403).json({ error: 'Account login, logout and credentials are managed by Codey' });
      return;
    }
    next();
  });

  router.get('/status', (req, res, next) => {
    try {
      if (portalSsoEnabled) {
        res.json({ needsSetup: false, isAuthenticated: true, managedAuthentication: true, user: (req as AuthenticatedRequest).user });
        return;
      }
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
