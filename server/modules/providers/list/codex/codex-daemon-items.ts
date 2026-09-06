import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * Used by the Codex daemon runtime and history reader. Projects app-server
 * items onto the existing provider normalizer, preserving IDs across progress,
 * completion, and history reloads rather than synthesizing a second transcript.
 */
export function projectCodexDaemonItem(
  value: unknown,
  turnId: string,
  timestamp: string,
): AnyRecord[] {
  const item = readObjectRecord(value);
  if (!item || typeof item.id !== 'string') return [];
  const base = { uuid: item.id, itemId: item.id, timestamp };
  const status = item.status === 'inProgress' ? 'in_progress' : item.status;
  const live = { ...base, type: 'item', status };

  switch (item.type) {
    case 'userMessage':
      return [{
        ...base,
        turnId,
        message: { role: 'user', content: item.content },
        images: Array.isArray(item.content)
          ? item.content.filter((part: AnyRecord) => part?.type === 'localImage')
            .map((part: AnyRecord) => ({ path: part.path }))
          : undefined,
      }];
    case 'agentMessage':
      return [{ ...base, message: { role: 'assistant', content: item.text || '' } }];
    case 'reasoning':
      return [{
        ...base, type: 'thinking',
        message: { content: Array.isArray(item.summary) ? item.summary.join('\n') : '' },
      }];
    case 'commandExecution':
      return [{
        ...live, itemType: 'command_execution',
        command: item.command, output: item.aggregatedOutput || '', exitCode: item.exitCode,
      }];
    case 'mcpToolCall':
      return [{
        ...live, itemType: 'mcp_tool_call', server: item.server, tool: item.tool,
        arguments: item.arguments, result: item.result, error: item.error,
      }];
    case 'fileChange': {
      const changes: AnyRecord[] = Array.isArray(item.changes) ? item.changes : [];
      const records: AnyRecord[] = [{
        ...live, itemType: 'file_change',
        changes: changes.map((change) => ({
          ...change, kind: readObjectRecord(change.kind)?.type ?? change.kind,
        })),
      }];
      if (status !== 'in_progress') {
        for (const [index, change] of changes.entries()) {
          records.push({
            ...base, uuid: `${item.id}_${index}_result`, type: 'tool_result',
            toolCallId: `${item.id}_${index}`, output: change.diff || '',
            isError: status === 'failed',
          });
        }
      }
      return records;
    }
    case 'plan':
      return [{ ...base, type: 'tool_use', toolName: 'ExitPlanMode', toolCallId: item.id, toolInput: { plan: item.text || '' } }];
    case 'webSearch':
      return [{ ...live, itemType: 'web_search', query: item.action?.query ?? item.query ?? '' }];
    case 'dynamicToolCall': {
      const records: AnyRecord[] = [{
        ...base, type: 'tool_use', toolName: item.tool || 'Tool',
        toolCallId: item.id, toolInput: item.arguments,
      }];
      if (status !== 'in_progress') {
        records.push({
          ...base, uuid: `${item.id}_result`, type: 'tool_result',
          toolCallId: item.id, output: JSON.stringify(item.contentItems ?? item.result ?? ''),
          isError: status === 'failed' || item.success === false,
        });
      }
      return records;
    }
    case 'contextCompaction':
      return [{ ...base, type: 'status_note', content: 'Codex compacted this conversation.' }];
    default:
      return [];
  }
}
