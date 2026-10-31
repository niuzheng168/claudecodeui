import spawn from 'cross-spawn';

import { AppError } from '@/shared/index.js';
import type { AzureDevOpsTarget } from '@/shared/index.js';

const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const MAX_ITEMS = 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const BASE_FIELDS = ['System.Id', 'System.TeamProject', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo'];
type Json = Record<string, any>;

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
function description(html: unknown): string {
  return text(html, 128000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    })[entity] ?? entity)
    .trim().slice(0, 32000);
}

function itemView(raw: Json, target: AzureDevOpsTarget, columns: { referenceName: string }[], detail = false) {
  const fields: Json = raw.fields ?? {};
  const project = text(fields['System.TeamProject'], 128) || target.project;
  return {
    id: raw.id, title: text(fields['System.Title']), type: text(fields['System.WorkItemType'], 100),
    state: text(fields['System.State'], 100), assignedTo: text(fields['System.AssignedTo'], 200), project,
    url: `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(project)}/_workitems/edit/${raw.id}`,
    values: Object.fromEntries(columns.map(column => [column.referenceName, text(fields[column.referenceName])])),
    ...(detail ? { description: description(fields['System.Description']) } : {}),
  };
}

/** The owner-only routes use this bounded reader; no create/update/delete ADO operations exist. */
export class AzureDevOpsService {
  private active = 0;
  constructor(private readonly options: { fetch?: typeof fetch; token?: () => Promise<string>; clock?: () => number } = {}) {}

  async read(target: AzureDevOpsTarget) {
    if (this.active >= 4) throw failure('正在执行其他 ADO 查询，请稍后重试', 429, 'ADO_BUSY');
    this.active++;
    const signal = AbortSignal.timeout(60000);
    try {
      const token = await (this.options.token ?? localToken)();
      const base = `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(target.project)}/_apis/wit/`;
      const request = async (suffix: string, body?: Json): Promise<Json> => {
        const response = await (this.options.fetch ?? fetch)(`${base}${suffix}${suffix.includes('?') ? '&' : '?'}api-version=7.1`, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status)) throw failure('当前 main 节点的 Azure 身份无权读取此查询或工单，请检查 az login 和 ADO 权限。', 403, 'ADO_FORBIDDEN');
          if (response.status === 404) throw failure('查询或工单不存在，或当前 Azure 身份无权查看。', 404, 'ADO_NOT_FOUND');
          if (response.status === 429) throw failure('ADO 请求过于频繁，请稍后重试。', 429, 'ADO_RATE_LIMIT');
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
      const fetchedAt = () => new Date((this.options.clock ?? Date.now)()).toISOString();
      if (target.kind === 'item') {
        const item = itemView(await request(`workitems/${target.id}`), target, [], true);
        return { contract: 1, title: item.title, queryType: 'item', items: [item], columns: [], relations: [], missingIds: [], truncated: false, fetchedAt: fetchedAt() };
      }
      const metadata = await request(`queries/${target.id}`);
      if (metadata.isFolder) throw failure('请选择具体的已保存查询，不是查询文件夹。', 400, 'ADO_QUERY_INVALID');
      const result = await request(`wiql/${target.id}?$top=${MAX_ITEMS + 1}`);
      const columns: { referenceName: string; name: string }[] = (result.columns ?? [])
        .filter((column: Json) => typeof column.referenceName === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(column.referenceName))
        .slice(0, 32).map((column: Json) => ({ referenceName: column.referenceName, name: text(column.name, 120) }));
      const ids = new Set<number>();
      const validId = (id: unknown): id is number => Number.isInteger(id) && Number(id) > 0 && Number(id) <= 2147483647;
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
        const batch = await request('workitemsbatch', {
          ids: selected.slice(offset, offset + 200), fields, errorPolicy: 'Omit',
          ...(typeof result.asOf === 'string' ? { asOf: result.asOf } : {}),
        });
        for (const raw of batch.value ?? []) if (selectedSet.has(raw.id)) items.push(itemView(raw, target, columns));
      }
      const byId = new Map(items.map(item => [item.id, item]));
      return {
        contract: 1, title: text(metadata.name) || `Query ${target.id}`, queryType: text(result.queryType, 32),
        columns, items: selected.filter(id => byId.has(id)).map(id => byId.get(id)!),
        relations: relations.filter(edge => selectedSet.has(edge.targetId) && (!edge.sourceId || selectedSet.has(edge.sourceId))),
        missingIds: selected.filter(id => !byId.has(id)),
        truncated: ids.size > MAX_ITEMS || (result.workItems?.length ?? 0) > MAX_ITEMS ||
          (result.workItemRelations?.length ?? 0) > MAX_ITEMS,
        fetchedAt: fetchedAt(), asOf: text(result.asOf, 64),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fetch errors can include URLs, CLI errors can contain tokens: expose neither.
      throw failure('ADO 读取失败或超时，请检查主节点网络和 Azure 登录后重试。');
    } finally { this.active--; }
  }
}
