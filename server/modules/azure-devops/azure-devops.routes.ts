import express from 'express';

import { isCodeyOwnerRequest } from '@/modules/auth/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';
import type { AzureDevOpsTarget } from '@/shared/index.js';

import { AzureDevOpsService } from './services/azure-devops.service.js';

function target(body: unknown): AzureDevOpsTarget {
  const invalid = () => new AppError('Invalid Azure DevOps target.', { code: 'ADO_INVALID_TARGET', statusCode: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['organization', 'project', 'kind', 'id'].includes(key))) throw invalid();
  const value = body as AzureDevOpsTarget;
  if (typeof value.organization !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(value.organization) ||
      typeof value.project !== 'string' || !value.project || value.project.length > 128 ||
      /[/\\?#\u0000-\u001f\u007f]/.test(value.project) || ['.', '..'].includes(value.project) ||
      typeof value.id !== 'string') throw invalid();
  if (value.kind === 'query' ? !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id)
    : value.kind !== 'item' || !/^[1-9]\d{0,9}$/.test(value.id) || Number(value.id) > 2147483647) throw invalid();
  return { organization: value.organization, project: value.project, kind: value.kind, id: value.id };
}

/** Mounted by the node entrypoint; ordinary local JWTs and shared sessions cannot use Azure credentials. */
export function createAzureDevOpsRoutes(
  service: Pick<AzureDevOpsService, 'read'> = new AzureDevOpsService(),
  isOwner = isCodeyOwnerRequest,
) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('cache-control', 'private, no-store');
    // ADO uses this node's verified owner identity, not project memory's
    // separately signed account namespace (which exists only on memory paths).
    if (!isOwner(req)) {
      next(new AppError('Azure DevOps requires owner SSO.', { code: 'ADO_FORBIDDEN', statusCode: 403 }));
    } else next();
  });
  router.post('/read', asyncHandler(async (req, res) => {
    res.json(await service.read(target(req.body)));
  }));
  return router;
}
