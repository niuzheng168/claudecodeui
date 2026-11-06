import spawn from 'cross-spawn';

import { AppError } from '@/shared/index.js';
import type { AzureDevOpsTarget } from '@/shared/index.js';

const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const MAX_ITEMS = 1000;
const MAX_INTAKE_ITEMS = 200;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const BASE_FIELDS = ['System.Id', 'System.TeamProject', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo'];
const INTAKE_FIELDS = [
  ...BASE_FIELDS, 'System.Rev', 'System.Tags', 'System.AreaPath', 'System.CreatedBy', 'System.CreatedDate', 'System.ChangedDate',
];
/** Closed in the stock processes: such an item is not received, and one awaiting the user leaves the intake. */
const CLOSED_STATES = ['Closed', 'Done', 'Removed', 'Resolved', 'Completed', 'Cut'];
type Json = Record<string, any>;

export type AzureDevOpsScope = { organization: string; project: string };
/** Items by ID, or the items a saved query returns. */
export type AzureDevOpsItemsInput = AzureDevOpsScope & ({ ids: number[] } | { queryId: string });
export type AzureDevOpsUpdateInput = AzureDevOpsScope & {
  id: string;
  comment?: string;
  addTags?: string[];
  removeTags?: string[];
  /** `creator` assigns the item back to whoever opened it. */
  assignTo?: string;
};

function failure(message: string, statusCode = 502, code = 'ADO_REQUEST_FAILED') {
  return new AppError(message, { statusCode, code });
}

/** Never return CLI diagnostics: stdout may be a token, stderr may contain account data. */
async function localToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('az', [
      'account', 'get-access-token', '--resource', RESOURCE, '--query', 'accessToken', '--output', 'tsv', '--only-show-errors',
    ], { shell: false, windowsHide: true, timeout: 20000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0, exceeded = false;
    const unavailable = () => reject(failure('请在 main 节点以运行 Codey 的用户安装 Azure CLI，并完成 az login；需要对目标 ADO 项目的访问权限。', 503, 'ADO_AUTH_REQUIRED'));
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32768) {
        exceeded = true;
        child.kill('SIGKILL');
        unavailable();
      } else chunks.push(chunk);
    });
    child.stderr?.resume();
    child.on('error', unavailable);
    child.on('close', code => {
      if (exceeded) return;
      const token = Buffer.concat(chunks).toString('utf8').trim();
      if (code !== 0 || !token || /\s/.test(token)) unavailable();
      else resolve(token);
    });
  });
}

function text(value: unknown, limit = 1024): string {
  if (typeof value === 'string') return value.slice(0, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && 'displayName' in value) return text(value.displayName, limit);
  return '';
}

/** Descriptions are plain text only; the UI never inserts upstream HTML into the DOM. */
function description(html: unknown, limit = 32000): string {
  return text(html, 128000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, entity => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&#39;': "'",
    })[entity] ?? entity)
    .replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, limit);
}

function tags(value: unknown): string[] {
  return text(value, 4000).split(';').map(tag => tag.trim()).filter(Boolean).slice(0, 64);
}

/** A comment is plain text: escaped, with line breaks kept. */
function commentHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
    .replace(/\r?\n/g, '<br>');
}

function itemUrl(scope: AzureDevOpsScope, project: string, id: unknown) {
  return `https://dev.azure.com/${encodeURIComponent(scope.organization)}/${encodeURIComponent(project || scope.project)}/_workitems/edit/${id}`;
}

function itemView(raw: Json, target: AzureDevOpsTarget, columns: { referenceName: string }[], detail = false) {
  const fields: Json = raw.fields ?? {};
  const project = text(fields['System.TeamProject'], 128) || target.project;
  return {
    id: raw.id, title: text(fields['System.Title']), type: text(fields['System.WorkItemType'], 100),
    state: text(fields['System.State'], 100), assignedTo: text(fields['System.AssignedTo'], 200), project,
    url: itemUrl(target, project, raw.id),
    values: Object.fromEntries(columns.map(column => [column.referenceName, text(fields[column.referenceName])])),
    ...(detail ? { description: description(fields['System.Description']) } : {}),
  };
}

function validId(id: unknown): id is number {
  return Number.isInteger(id) && Number(id) > 0 && Number(id) <= 2147483647;
}

function intakeView(raw: Json, scope: AzureDevOpsScope) {
  const fields: Json = raw.fields ?? {};
  const state = text(fields['System.State'], 100);
  return {
    id: raw.id, rev: Number(raw.rev ?? fields['System.Rev']) || 0, project: text(fields['System.TeamProject'], 128),
    title: text(fields['System.Title'], 500), type: text(fields['System.WorkItemType'], 100), state, closed: CLOSED_STATES.includes(state),
    tags: tags(fields['System.Tags']), areaPath: text(fields['System.AreaPath'], 400),
    createdBy: text(fields['System.CreatedBy'], 200), assignedTo: text(fields['System.AssignedTo'], 200),
    createdAt: text(fields['System.CreatedDate'], 64), changedAt: text(fields['System.ChangedDate'], 64),
    url: itemUrl(scope, text(fields['System.TeamProject'], 128), raw.id),
  };
}

type Request = (suffix: string, options?: { method?: string; body?: unknown; patch?: boolean; apiVersion?: string }) => Promise<Json>;

/**
 * Owner-only Azure DevOps access through this node's `az login`. Reads queries
 * and items; writes only comments, tags and the assignee of one item at a time.
 */
export class AzureDevOpsService {
  private active = 0;
  constructor(private readonly options: { fetch?: typeof fetch; token?: () => Promise<string>; clock?: () => number } = {}) {}

  private async session<T>(scope: AzureDevOpsScope, work: (request: Request) => Promise<T>): Promise<T> {
    if (this.active >= 4) throw failure('正在执行其他 ADO 查询，请稍后重试', 429, 'ADO_BUSY');
    this.active++;
    const signal = AbortSignal.timeout(60000);
    try {
      const token = await (this.options.token ?? localToken)();
      const base = `https://dev.azure.com/${encodeURIComponent(scope.organization)}/${encodeURIComponent(scope.project)}/_apis/wit/`;
      const request: Request = async (suffix, { method, body, patch = false, apiVersion = '7.1' } = {}) => {
        const response = await (this.options.fetch ?? fetch)(`${base}${suffix}${suffix.includes('?') ? '&' : '?'}api-version=${apiVersion}`, {
          method: method ?? (body ? 'POST' : 'GET'), redirect: 'error', signal,
          headers: {
            authorization: `Bearer ${token}`, accept: 'application/json',
            ...(body ? { 'content-type': patch ? 'application/json-patch+json' : 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status)) throw failure('当前 main 节点的 Azure 身份无权读取或修改此查询或工单，请检查 az login 和 ADO 权限。', 403, 'ADO_FORBIDDEN');
          if (response.status === 404) throw failure('查询或工单不存在，或当前 Azure 身份无权查看。', 404, 'ADO_NOT_FOUND');
          if (response.status === 429) throw failure('ADO 请求过于频繁，请稍后重试。', 429, 'ADO_RATE_LIMIT');
          if (patch && [409, 412].includes(response.status)) throw failure('工单刚被别人修改过，请刷新后重试。', 409, 'ADO_CONFLICT');
          if (patch && response.status === 400) throw failure('ADO 拒绝了这次修改，可能是指派的用户无效或工单不允许修改这些字段。', 400, 'ADO_UPDATE_INVALID');
          if (response.status === 400) throw failure('ADO 无法执行此查询；请检查查询条件和需要团队上下文的宏。', 400, 'ADO_QUERY_INVALID');
          throw failure('Azure DevOps 暂时不可用，请稍后重试。');
        }
        if (!response.headers.get('content-type')?.includes('application/json') || !response.body) {
          await response.body?.cancel();
          throw failure('ADO 没有返回有效数据，请检查 main 节点的 Azure 登录状态。');
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > MAX_RESPONSE_BYTES) throw failure('ADO 返回内容过大，请缩小查询范围。', 400, 'ADO_RESULT_TOO_LARGE');
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
      };
      return await work(request);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fetch errors can include URLs, CLI errors can contain tokens: expose neither.
      throw failure('ADO 读取失败或超时，请检查主节点网络和 Azure 登录后重试。');
    } finally { this.active--; }
  }

  private fetchedAt() {
    return new Date((this.options.clock ?? Date.now)()).toISOString();
  }

  async read(target: AzureDevOpsTarget) {
    return this.session(target, async request => {
      if (target.kind === 'item') {
        const item = itemView(await request(`workitems/${target.id}`), target, [], true);
        return { contract: 1, title: item.title, queryType: 'item', items: [item], columns: [], relations: [], missingIds: [], truncated: false, fetchedAt: this.fetchedAt() };
      }
      const metadata = await request(`queries/${target.id}`);
      if (metadata.isFolder) throw failure('请选择具体的已保存查询，不是查询文件夹。', 400, 'ADO_QUERY_INVALID');
      const result = await request(`wiql/${target.id}?$top=${MAX_ITEMS + 1}`);
      const columns: { referenceName: string; name: string }[] = (result.columns ?? [])
        .filter((column: Json) => typeof column.referenceName === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(column.referenceName))
        .slice(0, 32).map((column: Json) => ({ referenceName: column.referenceName, name: text(column.name, 120) }));
      const ids = new Set<number>();
      const relations: { sourceId: number | null; targetId: number; rel: string }[] = [];
      for (const reference of result.workItems ?? []) if (validId(reference.id)) ids.add(reference.id);
      for (const relation of result.workItemRelations ?? []) {
        const sourceId = validId(relation.source?.id) ? relation.source.id : null;
        const targetId = relation.target?.id;
        if (sourceId) ids.add(sourceId);
        if (validId(targetId)) {
          ids.add(targetId);
          relations.push({ sourceId, targetId, rel: text(relation.rel, 120) });
        }
      }
      const selected = [...ids].slice(0, MAX_ITEMS), selectedSet = new Set(selected);
      const fields = [...new Set([...BASE_FIELDS, ...columns.map(column => column.referenceName)])];
      const items = [];
      for (let offset = 0; offset < selected.length; offset += 200) {
        // This POST is the read-only batch API. ADO limits each batch to 200 IDs.
        const batch = await request('workitemsbatch', { body: {
          ids: selected.slice(offset, offset + 200), fields, errorPolicy: 'Omit',
          ...(typeof result.asOf === 'string' ? { asOf: result.asOf } : {}),
        } });
        // `Omit` leaves a null in place of an item that is gone or hidden.
        for (const raw of batch.value ?? []) if (selectedSet.has(raw?.id)) items.push(itemView(raw, target, columns));
      }
      const byId = new Map(items.map(item => [item.id, item]));
      return {
        contract: 1, title: text(metadata.name) || `Query ${target.id}`, queryType: text(result.queryType, 32),
        columns, items: selected.filter(id => byId.has(id)).map(id => byId.get(id)!),
        relations: relations.filter(edge => selectedSet.has(edge.targetId) && (!edge.sourceId || selectedSet.has(edge.sourceId))),
        missingIds: selected.filter(id => !byId.has(id)),
        truncated: ids.size > MAX_ITEMS || (result.workItems?.length ?? 0) > MAX_ITEMS ||
          (result.workItemRelations?.length ?? 0) > MAX_ITEMS,
        fetchedAt: this.fetchedAt(), asOf: text(result.asOf, 64),
      };
    });
  }

  /**
   * Metadata of received items (codey/docs/codey-ado-intake.md §4): up to 200
   * by ID, or the first 200 a saved query returns. No text, so it is cheap to poll.
   */
  async items(input: AzureDevOpsItemsInput) {
    return this.session(input, async request => {
      let ids: number[], truncated = false, asOf: unknown;
      if ('queryId' in input) {
        const result = await request(`wiql/${input.queryId}?$top=${MAX_INTAKE_ITEMS + 1}`);
        const found = new Set<number>();
        for (const reference of result.workItems ?? []) if (validId(reference.id)) found.add(reference.id);
        for (const relation of result.workItemRelations ?? []) {
          for (const end of [relation.source, relation.target]) if (validId(end?.id)) found.add(end.id);
        }
        ids = [...found].slice(0, MAX_INTAKE_ITEMS);
        truncated = found.size > MAX_INTAKE_ITEMS || (result.workItems?.length ?? 0) > MAX_INTAKE_ITEMS ||
          (result.workItemRelations?.length ?? 0) > MAX_INTAKE_ITEMS;
        asOf = result.asOf;
      } else ids = input.ids.slice(0, MAX_INTAKE_ITEMS);
      const items = ids.length ? ((await request('workitemsbatch', { body: {
        ids, fields: INTAKE_FIELDS, errorPolicy: 'Omit', ...(typeof asOf === 'string' ? { asOf } : {}),
      } })).value ?? []).filter((raw: Json) => ids.includes(raw?.id)).map((raw: Json) => intakeView(raw, input)) : [];
      const found = new Set(items.map((item: { id: number }) => item.id));
      return { contract: 1, items, missingIds: ids.filter(id => !found.has(id)), truncated, fetchedAt: this.fetchedAt() };
    });
  }

  /** One item with its text and newest comments, as plain text, for triage and for the session that works on it. */
  async item(input: AzureDevOpsScope & { id: string }) {
    return this.session(input, async request => {
      const raw = await request(`workitems/${input.id}`);
      let comments: { author: string; at: string; text: string }[] = [];
      try {
        const page = await request(`workItems/${input.id}/comments?$top=5&order=desc`, { apiVersion: '7.1-preview.4' });
        comments = (page.comments ?? []).slice(0, 5).map((comment: Json) => ({
          author: text(comment.createdBy, 200), at: text(comment.createdDate, 64), text: description(comment.text, 2000),
        })).filter((comment: { text: string }) => comment.text);
      } catch (error) {
        // Comments help but are optional; an account without them still triages.
        if (!(error instanceof AppError) || error.code === 'ADO_BUSY') throw error;
      }
      const fields: Json = raw.fields ?? {};
      return {
        contract: 1,
        item: {
          ...intakeView(raw, input),
          description: description(fields['System.Description'], 16000),
          reproSteps: description(fields['Microsoft.VSTS.TCM.ReproSteps'], 8000),
          comments,
        },
      };
    });
  }

  /**
   * Writes a comment, tag changes and/or the assignee in one JSON Patch that
   * tests the revision it was computed from, so a concurrent edit is not lost.
   */
  async update(input: AzureDevOpsUpdateInput) {
    return this.session(input, async request => {
      const current = await request(`workitems/${input.id}?fields=System.Tags,System.CreatedBy`);
      const fields: Json = current.fields ?? {};
      const remove = new Set((input.removeTags ?? []).map(tag => tag.toLowerCase()));
      const existing = tags(fields['System.Tags']);
      const next = existing.filter(tag => !remove.has(tag.toLowerCase()));
      for (const tag of input.addTags ?? []) if (!next.some(value => value.toLowerCase() === tag.toLowerCase())) next.push(tag);
      const operations: Json[] = [{ op: 'test', path: '/rev', value: current.rev }];
      // ADO merges an `add` into the existing tags, so only `replace` can remove one.
      if (next.join(';') !== existing.join(';')) {
        operations.push({ op: existing.length ? 'replace' : 'add', path: '/fields/System.Tags', value: next.join('; ') });
      }
      if (input.comment) operations.push({ op: 'add', path: '/fields/System.History', value: commentHtml(input.comment) });
      if (input.assignTo) {
        const creator = fields['System.CreatedBy'];
        const assignee = input.assignTo === 'creator' ? text(creator?.uniqueName, 256) : input.assignTo;
        if (!assignee) throw failure('读不到工单创建者，无法指派回去；请在退回时指定指派给谁。', 400, 'ADO_UPDATE_INVALID');
        operations.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignee });
      }
      if (operations.length === 1) return { contract: 1, id: current.id, rev: current.rev, changed: false };
      const updated = await request(`workitems/${input.id}`, { method: 'PATCH', body: operations, patch: true });
      return { contract: 1, id: updated.id, rev: updated.rev, changed: true };
    });
  }
}
