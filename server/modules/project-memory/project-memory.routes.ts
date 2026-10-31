import express from 'express';

import { isCodeyOwnerRequest, codeyOwnerAccountId } from '@/modules/auth/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';

import { projectMemoryStore, archiveMaterial, archiveJobs, memoryIntegrationStatus } from './services/project-memory-runtime.service.js';

/** Mounted by the node entrypoint; only an owner authenticated by the signed Portal SSO may use it. */
export function createProjectMemoryRoutes(service = projectMemoryStore, isOwnerRequest = isCodeyOwnerRequest, accountId = codeyOwnerAccountId) {
  const router = express.Router();
  router.use((req, _res, next) => {
    if (!isOwnerRequest(req)) {
      next(new AppError('Project memory requires owner SSO.', { code: 'FORBIDDEN', statusCode: 403 }));
      return;
    }
    next();
  });
  router.get('/info',(_req,res)=>res.json({contract:3,features:{noteDrafts:true,archiveWithoutMemory:true},integration:memoryIntegrationStatus()}));
  router.post('/projects/:project/notes/:operation', asyncHandler(async (req, res) => {
    const owner = accountId(req), project = String(req.params.project), operation = String(req.params.operation);
    if (!owner) throw new AppError('Verified account identity required.', {statusCode:403});
    if (!/^p-[a-f0-9]{16}$/.test(project) || !['preview', 'confirm'].includes(operation)) {
      throw new AppError('Invalid memory note path.', {statusCode:400});
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16384) throw new AppError('Note too large.', {statusCode:413});
    res.json(operation === 'preview' ? await service.previewNote(owner, project, req.body) : await service.confirmNote(owner, project, req.body));
  }));
  // A dedicated bounded transcript route avoids shipping tool outputs, reasoning or secrets to Portal.
  router.post('/sessions/:sessionId/material', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.sessionId);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)) {
      throw new AppError('Invalid session.', { statusCode: 400 });
    }
    res.json(await archiveMaterial.read(sessionId,req.body));
  }));
  router.all('/projects/:project/jobs/:jobId?',asyncHandler(async (req,res) => {
    const owner=accountId(req), project=String(req.params.project), id=req.params.jobId ? String(req.params.jobId):undefined;
    if (!owner) throw new AppError('Verified account identity required.',{statusCode:403});
    if (!/^p-[a-f0-9]{16}$/.test(project) || (id && !/^[a-f0-9]{64}$/.test(id))) throw new AppError('Invalid memory job path.',{statusCode:400});
    if (Buffer.byteLength(JSON.stringify(req.body ?? {}))>16384) throw new AppError('Job metadata too large.',{statusCode:413});
    if (req.method==='POST' && !id) res.status(202).json(await archiveJobs.enqueue(owner,project,req.body));
    else if (req.method==='GET' && id) res.json(await archiveJobs.status(owner,project,id));
    else res.sendStatus(405);
  }));
  router.all('/projects/:project/memory/:entry?', asyncHandler(async (req, res) => {
    const project = String(req.params.project);
    const entry = req.params.entry ? String(req.params.entry) : undefined;
    const owner = accountId(req);
    if (!owner) throw new AppError('Verified account identity required.', {statusCode:403});
    if (!/^p-[a-f0-9]{16}$/.test(project) || (entry && !/^(?:m-[a-f0-9]{16}|import|summarize)$/.test(entry))) {
      throw new AppError('Invalid project memory path.', { statusCode: 400 });
    }
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 8 * 1024 * 1024) {
      throw new AppError('Memory request too large.', { statusCode: 413 });
    }
    if (entry === 'import' && req.method === 'POST') res.json(await service.importLegacy(owner, project, req.body));
    else if (entry === 'summarize') res.status(410).json({error:'Turn summarization retired; submit a confirmed archive job.'});
    else if (entry && !entry.startsWith('m-')) res.sendStatus(405);
    else if (req.method === 'GET') {
      const offset=Number(req.query.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset<0) throw new AppError('Invalid cursor.',{statusCode:400});
      const revision=req.query.revision===undefined ? undefined:Number(req.query.revision);
      if (revision!==undefined && (!Number.isSafeInteger(revision)||revision<0)) throw new AppError('Invalid revision.',{statusCode:400});
      res.json(entry ? await service.history(owner,project,entry,offset,revision) : {...await service.list(owner,project,offset,revision),integration:memoryIntegrationStatus()});
    }
    else if (req.method === 'POST' && !entry) res.status(201).json(await service.create(owner, project, req.body));
    else if (req.method === 'PATCH' && entry) res.json(await service.update(owner, project, entry, req.body));
    else if (req.method === 'DELETE') res.json(await service.remove(owner, project, entry));
    else res.sendStatus(405);
  }));
  return router;
}
