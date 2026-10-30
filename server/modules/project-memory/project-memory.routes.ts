import express from 'express';

import { isCodeyOwnerRequest } from '@/modules/auth/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';

import { ProjectMemoryService, readProjectMemoryMaterial } from './services/project-memory.service.js';

/** Mounted by the node entrypoint; only an owner authenticated by the signed Portal SSO may use it. */
export function createProjectMemoryRoutes(service = new ProjectMemoryService(), isOwnerRequest = isCodeyOwnerRequest) {
  const router = express.Router();
  router.use((req, _res, next) => {
    if (!isOwnerRequest(req)) {
      next(new AppError('Project memory requires owner SSO.', { code: 'FORBIDDEN', statusCode: 403 }));
      return;
    }
    next();
  });
  // A dedicated bounded transcript route avoids shipping tool outputs, reasoning or secrets to Portal.
  router.post('/sessions/:sessionId/material', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.sessionId);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)) {
      throw new AppError('Invalid session.', { statusCode: 400 });
    }
    const { through, after = null } = req.body ?? {};
    if (!Number.isSafeInteger(through) || through <= 0 || (after !== null && (!Number.isSafeInteger(after) || after >= through))) {
      throw new AppError('Invalid turn boundary.', { statusCode: 400 });
    }
    res.json(await readProjectMemoryMaterial(sessionId, through, after));
  }));
  router.all('/projects/:project/memory/:entry?', asyncHandler(async (req, res) => {
    const project = String(req.params.project);
    const entry = req.params.entry ? String(req.params.entry) : undefined;
    const owner = (req as typeof req & { user: { username: string } }).user.username;
    if (!/^p-[a-f0-9]{16}$/.test(project) || (entry && !/^(?:m-[a-f0-9]{16}|import|summarize)$/.test(entry))) {
      throw new AppError('Invalid project memory path.', { statusCode: 400 });
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > (entry === 'import' ? 8 * 1024 * 1024 : 768 * 1024)) {
      throw new AppError('Memory request too large.', { statusCode: 413 });
    }
    if (entry === 'import' && req.method === 'POST') res.json(await service.importLegacy(owner, project, req.body));
    else if (entry === 'summarize' && req.method === 'POST') res.json(await service.summarize(owner, project, req.body));
    else if (entry && !entry.startsWith('m-')) res.sendStatus(405);
    else if (req.method === 'GET') res.json(entry ? await service.history(owner, project, entry) : await service.list(owner, project));
    else if (req.method === 'POST' && !entry) res.status(201).json(await service.create(owner, project, req.body));
    else if (req.method === 'PATCH' && entry) res.json(await service.update(owner, project, entry, req.body));
    else if (req.method === 'DELETE') res.json(await service.remove(owner, project, entry));
    else res.sendStatus(405);
  }));
  return router;
}
