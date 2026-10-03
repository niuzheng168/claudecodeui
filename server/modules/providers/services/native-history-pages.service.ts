import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AppError } from '@/shared/index.js';
import type { CodexHistoryPageRequest, FetchHistoryOptions, FetchHistoryResult, NativeTranscriptPosition } from '@/shared/index.js';

type Boundary = {
  source: string;
  anchor: string;
  cursor: string | null;
  position: NativeTranscriptPosition;
  direction: 'asc' | 'desc';
  expires: number;
};

/**
 * SessionsService uses this for native cold/older pages and their forward
 * refreshes. Cursors are signed and source-bound; no whole history allocation,
 * transcript file copying, writer acquisition or client-provided positions.
 */
export function createNativeHistoryPages({ now = Date.now } = {}) {
  const key = randomBytes(32);
  const digest = (body: string) => createHmac('sha256', key).update(body).digest();
  const sourceId = (source: string) => createHash('sha256').update(source).digest('hex');
  const sign = (boundary: Boundary) => {
    const body = Buffer.from(JSON.stringify(boundary)).toString('base64url');
    return `np.${body}.${digest(body).toString('base64url')}`;
  };
  function verify(token: string, source: string, anchor: string, direction: Boundary['direction']): Boundary {
    try {
      const [prefix, body, mac, extra] = token.split('.');
      const received = Buffer.from(mac ?? '', 'base64url');
      if (prefix !== 'np' || extra || received.length !== 32 || !timingSafeEqual(digest(body), received)) throw new Error('invalid');
      const boundary = JSON.parse(Buffer.from(body, 'base64url').toString()) as Boundary;
      if (boundary.expires < now()) throw new Error('expired');
      if (boundary.source !== sourceId(source) || boundary.anchor !== anchor || boundary.direction !== direction) {
        throw new AppError('This native page cursor belongs to another session or boundary.', {
          code: 'HISTORY_SNAPSHOT_MISMATCH', statusCode: 409,
        });
      }
      return boundary;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('This native page cursor expired. Reload the latest history page.', {
        code: 'HISTORY_SNAPSHOT_EXPIRED', statusCode: 409,
      });
    }
  }

  return {
    async page({
      source, options, load,
    }: {
      source: string;
      options: Pick<FetchHistoryOptions, 'limit' | 'before' | 'after' | 'syncCursor' | 'beforeCursor'>;
      load: (page: CodexHistoryPageRequest) => Promise<FetchHistoryResult>;
    }): Promise<FetchHistoryResult> {
      const direction = options.after ? 'asc' : 'desc';
      const token = options.after ? options.syncCursor : options.beforeCursor;
      const anchor = options.after ?? options.before;
      const boundary = token && anchor ? verify(token, source, anchor, direction) : null;
      if (anchor && !boundary) throw new AppError('A native row boundary requires its signed page cursor.', {
        code: 'HISTORY_SNAPSHOT_EXPIRED', statusCode: 409,
      });
      const limit = Math.max(2, Math.min(100, options.limit ?? 20));
      const result = await load({
        direction, cursor: boundary?.cursor ?? null, index: boundary?.position.itemIndex ?? 0,
        orderScope: boundary?.position.orderScope ?? randomUUID(), limit: limit + (boundary && direction === 'desc' ? 1 : 0),
      });
      let messages = result.messages;
      if (boundary) {
        const repeated = direction === 'asc' ? messages[0] : messages.find(message => message.id === boundary.anchor);
        if (repeated?.id !== boundary.anchor) throw new AppError('The native history anchor was removed or changed.', {
          code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
        });
        if (direction === 'desc') {
          // Replay the oldest native item for validation. Keep projections
          // before a cache-trimmed row, but never repeat the retained boundary.
          messages = messages.slice(0, messages.findIndex(message => message.id === boundary.anchor));
        }
      }
      // Native paging does not count the entire fork. Report only this page's
      // known rows; the store tracks its loaded count, never an invented total.
      const total = messages.length;
      const response: FetchHistoryResult = {
        ...result, messages, total, offset: 0, limit,
        totalIsExact: !boundary && result.totalIsExact === true,
        ...(options.before ? { before: options.before } : {}),
        ...(options.after ? { after: options.after } : {}),
      };
      const first = messages[0], last = messages.at(-1);
      const signed = (message: NonNullable<typeof first>, cursor: string | null, direction: Boundary['direction']) => sign({
        source: sourceId(source), anchor: message.id, cursor, direction, position: message.nativePosition!,
        expires: now() + 7 * 24 * 60 * 60_000,
      });
      // Any retained row can become the cache's oldest boundary after trimming.
      // Carry its own signed seek point so older paging never skips discarded
      // rows or falls back to traversing the complete fork.
      response.messages = messages.map(message => {
        if (!message.nativePosition || (typeof message.historyBeforeCursor !== 'string' && message.historyBeforeCursor !== null)) return message;
        return { ...message, historyPageBefore: signed(message, message.historyBeforeCursor, 'desc') };
      });
      if (first?.nativePosition && (typeof first.historyBeforeCursor === 'string' || first.historyBeforeCursor === null)) {
        response.beforeCursor = signed(first, first.historyBeforeCursor, 'desc');
      }
      if (last?.nativePosition?.cursor !== undefined) {
        const start = messages.find(message => message.nativePosition?.itemId === last.nativePosition?.itemId)!;
        response.syncCursor = signed(start, last.nativePosition.cursor, 'asc');
      }
      return response;
    },
  };
}

/** Used by SessionsService; keys exist only for this node process, never on the client. */
export const nativeHistoryPages = createNativeHistoryPages();
