import { AppError, readObjectRecord } from '@/shared/index.js';
import type { AnyRecord, ICodexRpcClient } from '@/shared/index.js';

const MAX_TURN_ITEMS = 100_000;
const MAX_TURN_BYTES = 128 * 1024 * 1024;
const MAX_READ_DURATION_MS = 60_000;

/**
 * Used by the desktop queue observer and shared runtime to read live turns
 * without combining screenshot-bearing items into oversized transport frames.
 * Only read RPCs are allowed here; capability failures never retry user input.
 */
export class CodexNativeTurnReader {
  private itemPaginationConfirmed = false;
  private legacyFullTurns = false;

  constructor(private readonly client: ICodexRpcClient, private readonly threadId: string) {}

  async page(cursor: string | null = null): Promise<AnyRecord> {
    const result = await this.client.request('thread/turns/list', {
      // Even an older backend that ignores itemsView must not combine turns.
      threadId: this.threadId, cursor, limit: 1, sortDirection: 'desc',
      itemsView: this.legacyFullTurns ? 'full' : 'notLoaded',
    });
    this.validatePage(result);
    return result;
  }

  async hydrate(turn: AnyRecord, turnCursor: string | null): Promise<AnyRecord> {
    if (turn.itemsView !== 'notLoaded') {
      this.validateItems(turn.items);
      return turn;
    }
    const items: AnyRecord[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    const deadline = Date.now() + MAX_READ_DURATION_MS;
    let bytes = 0;
    let cursor: string | null = null;
    do {
      if (Date.now() > deadline) throw this.invalid();
      let result: AnyRecord;
      try {
        result = await this.client.request('thread/items/list', {
          threadId: this.threadId, turnId: turn.id, cursor, limit: 1, sortDirection: 'asc',
        });
      } catch (error) {
        if (this.itemPaginationConfirmed || !(error instanceof AppError)
          || !['CODEX_STDIO_RPC_ERROR', 'CODEX_DAEMON_RPC_ERROR'].includes(error.code)
          || readObjectRecord(error.details)?.rpcCode !== -32601) throw error;
        // Only an initial explicit unsupported-method response permits legacy
        // full-turn reads. A new newest turn must not replace the selected one.
        const legacy = await this.client.request('thread/turns/list', {
          threadId: this.threadId, cursor: turnCursor, limit: 1, sortDirection: 'desc', itemsView: 'full',
        });
        this.validatePage(legacy);
        const full = legacy.data[0];
        if (!full || full.id !== turn.id || full.itemsView === 'notLoaded') throw this.invalid();
        this.validateItems(full.items);
        this.legacyFullTurns = true;
        return full;
      }
      if (!readObjectRecord(result) || !Array.isArray(result.data) || result.data.length > 1
        || !Object.hasOwn(result, 'nextCursor')) throw this.invalid();
      this.itemPaginationConfirmed = true;
      for (const entry of result.data) {
        const item = readObjectRecord(entry?.item);
        if (entry?.turnId !== turn.id || !item || !this.validItem(item) || ids.has(item.id)) throw this.invalid();
        ids.add(item.id);
        bytes += Buffer.byteLength(JSON.stringify(item));
        if (ids.size > MAX_TURN_ITEMS || bytes > MAX_TURN_BYTES || Date.now() > deadline) throw this.invalid();
        items.push(item);
      }
      cursor = result.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor)
        || result.data.length === 0)) throw this.invalid();
      if (cursor != null) cursors.add(cursor);
      if (Date.now() > deadline) throw this.invalid();
    } while (cursor != null);
    return { ...turn, itemsView: 'full', items };
  }

  private validatePage(result: AnyRecord): void {
    if (!readObjectRecord(result) || !Array.isArray(result.data) || result.data.length > 1
      || !Object.hasOwn(result, 'nextCursor')
      || (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !result.nextCursor
        || result.data.length === 0))) throw this.invalid();
    for (const turn of result.data) {
      if (!readObjectRecord(turn) || typeof turn.id !== 'string' || !turn.id || !Array.isArray(turn.items)
        || (turn.itemsView != null && !['full', 'notLoaded'].includes(turn.itemsView))
        || (turn.itemsView === 'notLoaded' && turn.items.length !== 0)) throw this.invalid();
    }
  }

  private validateItems(items: AnyRecord[]): void {
    const ids = new Set<string>();
    if (items.length > MAX_TURN_ITEMS || Buffer.byteLength(JSON.stringify(items)) > MAX_TURN_BYTES) throw this.invalid();
    for (const item of items) {
      if (!readObjectRecord(item) || !this.validItem(item) || ids.has(item.id)) throw this.invalid();
      ids.add(item.id);
    }
  }

  private validItem(item: AnyRecord): boolean {
    return typeof item.id === 'string' && Boolean(item.id) && typeof item.type === 'string' && Boolean(item.type);
  }

  private invalid(): AppError {
    return new AppError('Codex returned incomplete or invalid live turn history. No input was retried.', {
      code: 'CODEX_NATIVE_TURN_PROTOCOL_ERROR', statusCode: 502,
    });
  }
}
