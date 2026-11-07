import express from 'express';

import { isCodeyOwnerRequest } from '@/modules/auth/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';
import type { AzureDevOpsTarget } from '@/shared/index.js';

import { AzureDevOpsService } from './services/azure-devops.service.js';
import type { AzureDevOpsItemsInput, AzureDevOpsScope, AzureDevOpsUpdateInput } from './services/azure-devops.service.js';
import { readTriageContext, triageWorkItem } from './services/work-item-triage.service.js';

/** What the Portal checks before using the intake routes (codey/docs/codey-ado-intake.md §8). */
const FEATURES = ['read', 'items', 'item', 'triage', 'update', 'close'];
const TAG = /^[A-Za-z0-9_.-]{1,64}$/;
const ITEM_ID = /^[1-9]\d{0,9}$/;
const QUERY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const EMAIL = /^[^\s@<>;,"]{1,128}@[^\s@<>;,"]{1,128}$/;

function invalid() {
  return new AppError('Invalid Azure DevOps target.', { code: 'ADO_INVALID_TARGET', statusCode: 400 });
}

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}

function scope(value: Record<string, unknown>): AzureDevOpsScope {
  if (typeof value.organization !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(value.organization) ||
      typeof value.project !== 'string' || !value.project || value.project.length > 128 ||
      /[/\\?#\u0000-\u001f\u007f]/.test(value.project) || ['.', '..'].includes(value.project)) throw invalid();
  return { organization: value.organization, project: value.project };
}

function itemId(value: unknown): string {
  if (typeof value !== 'string' || !ITEM_ID.test(value) || Number(value) > 2147483647) throw invalid();
  return value;
}

function target(value: unknown): AzureDevOpsTarget {
  const input = body(value, ['organization', 'project', 'kind', 'id']);
  const base = scope(input);
  if (typeof input.id !== 'string') throw invalid();
  if (input.kind === 'query' ? !QUERY_ID.test(input.id)
    : input.kind !== 'item' || itemId(input.id) !== input.id) throw invalid();
  return { ...base, kind: input.kind as AzureDevOpsTarget['kind'], id: input.id };
}

function items(value: unknown): AzureDevOpsItemsInput {
  const input = body(value, ['organization', 'project', 'ids', 'queryId']);
  if (input.queryId !== undefined) {
    if (input.ids !== undefined || typeof input.queryId !== 'string' || !QUERY_ID.test(input.queryId)) throw invalid();
    return { ...scope(input), queryId: input.queryId };
  }
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 200 ||
      input.ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) throw invalid();
  return { ...scope(input), ids: [...new Set(input.ids as number[])] };
}

function tagList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4 || value.some(tag => typeof tag !== 'string' || !TAG.test(tag))) throw invalid();
  return value;
}

function update(value: unknown): AzureDevOpsUpdateInput {
  const input = body(value, ['organization', 'project', 'id', 'comment', 'addTags', 'removeTags', 'assignTo', 'close']);
  if (input.comment !== undefined && (typeof input.comment !== 'string' || !input.comment.trim() || input.comment.length > 4000)) throw invalid();
  if (input.assignTo !== undefined && (typeof input.assignTo !== 'string' || (input.assignTo !== 'creator' && !EMAIL.test(input.assignTo)))) throw invalid();
  if (input.close !== undefined && input.close !== 'completed' && input.close !== 'removed') throw invalid();
  return {
    ...scope(input), id: itemId(input.id),
    ...(input.comment ? { comment: input.comment as string } : {}),
    ...(input.assignTo ? { assignTo: input.assignTo as string } : {}),
    ...(input.close ? { close: input.close as AzureDevOpsUpdateInput['close'] } : {}),
    addTags: tagList(input.addTags), removeTags: tagList(input.removeTags),
  };
}

type Service = Pick<AzureDevOpsService, 'read' | 'items' | 'item' | 'update'>;

/** Route tests may supply only the operations they exercise. */
function operation<K extends keyof Service>(service: Partial<Service>, name: K): Service[K] {
  const method = service[name];
  if (!method) throw new AppError('Not supported.', { code: 'ADO_UNSUPPORTED', statusCode: 404 });
  return method.bind(service) as Service[K];
}

/** Mounted by the node entrypoint; ordinary local JWTs and shared sessions cannot use Azure credentials. */
export function createAzureDevOpsRoutes(
  service: Partial<Service> = new AzureDevOpsService(),
  isOwner = isCodeyOwnerRequest,
  triage = triageWorkItem,
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
  router.get('/info', (_req, res) => {
    res.json({ contract: 1, features: FEATURES });
  });
  router.post('/read', asyncHandler(async (req, res) => {
    res.json(await operation(service, 'read')(target(req.body)));
  }));
  router.post('/items', asyncHandler(async (req, res) => {
    res.json(await operation(service, 'items')(items(req.body)));
  }));
  router.post('/item', asyncHandler(async (req, res) => {
    const input = body(req.body, ['organization', 'project', 'id']);
    res.json(await operation(service, 'item')({ ...scope(input), id: itemId(input.id) }));
  }));
  router.post('/triage', asyncHandler(async (req, res) => {
    const input = body(req.body, ['organization', 'project', 'id', 'context']);
    const ref = { ...scope(input), id: itemId(input.id) };
    const context = readTriageContext(input.context);
    const { item } = await operation(service, 'item')(ref);
    const result = await triage(item, context);
    const { description: _description, reproSteps: _reproSteps, comments: _comments, ...metadata } = item;
    res.json({ contract: 1, item: metadata, result });
  }));
  router.post('/update', asyncHandler(async (req, res) => {
    res.json(await operation(service, 'update')(update(req.body)));
  }));
  return router;
}
