import express from 'express';

import type { createCodeyProxiesService } from './codey-proxies.service.js';

/** Mounted under Settings; ownership is checked before accessing the gateway admin key. */
export function createCodeyProxiesRouter(
  service: ReturnType<typeof createCodeyProxiesService>,
  isOwner: (request: express.Request) => boolean,
) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isOwner(req)) {
      res.status(403).json({ error: 'Only the authenticated Codey node owner may configure model proxies.' });
      return;
    }
    next();
  });
  router.get('/', async (_req, res, next) => {
    try { res.json(await service.read()); } catch (error) { next(error); }
  });
  router.put('/', async (req, res, next) => {
    try { res.json(await service.save(req.body)); } catch (error) { next(error); }
  });
  return router;
}
