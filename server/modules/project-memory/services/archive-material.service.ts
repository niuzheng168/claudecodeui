import { createHash } from 'node:crypto';

import { memoryArchiveDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { AppError, redactProjectMemoryText as redact, readObjectRecord } from '@/shared/index.js';
import type { MemoryCheckpoint } from '@/shared/index.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function stale(): never { throw new AppError('归档状态或内容已变化。', {code:'ARCHIVE_STALE',statusCode:409}); }

/**
 * Source-side history reader used by the archive outbox and the signed material
 * route. No transcript cache or permanent per-session summary is written.
 * Provider snapshots and a content hash fence make every cursor content-bound.
 */
export class ArchiveMaterialService {
  constructor(private readonly reader: Pick<typeof sessionsService,'getSessionDetailsById'|'fetchHistory'> = sessionsService) {}

  private async pieces(id: string): Promise<string[]> {
    const pages: string[][] = [];
    let offset=0, snapshotId: string|undefined, before: string|undefined, beforeCursor: string|undefined;
    const seen = new Set<string>();
    for (;;) {
      const history = await this.reader.fetchHistory(id,{limit:100,...(snapshotId?{snapshotId}:{}),
        ...(before && beforeCursor ? {before,beforeCursor}:{offset})}).catch(error=>{
          if ((error as AppError).statusCode===404
            || ((error as AppError).code==='CODEX_HISTORY_UNAVAILABLE' && readObjectRecord((error as AppError).details)?.missing===true)) {
            throw new AppError('会话正文已不存在。',{code:'SESSION_NOT_FOUND',statusCode:404});
          }
          throw error;
        });
      snapshotId=history.snapshotId ?? snapshotId;
      const page: string[] = [];
      for (const message of history.messages) {
        if (message.kind!=='text' || !['user','assistant'].includes(message.role ?? '')
          || message.isCompactSummary || message.isLocalCommand || message.isLocalCommandStdout || typeof message.content!=='string') continue;
        const content=Array.from(redact(message.content));
        // Split very long individual messages without cutting UTF-16 surrogate pairs.
        for (let i=0;i<content.length;i+=750) page.push(JSON.stringify({
          id:message.id,at:message.timestamp,role:message.role,part:i/750,text:content.slice(i,i+750).join(''),
        }));
      }
      pages.unshift(page);
      if (!history.hasMore) break;
      if (!history.messages.length) throw new AppError('会话历史分页不完整。',{statusCode:503});
      before=history.messages[0]?.id; beforeCursor=history.beforeCursor; offset+=history.messages.length;
      const cursor=beforeCursor ?? `${offset}`;
      if (seen.has(cursor)) throw new AppError('会话历史游标重复。',{statusCode:503});
      seen.add(cursor);
    }
    return pages.flat();
  }

  async capture(id: string, revision: number): Promise<string> {
    const state=memoryArchiveDb.get(id);
    if (!state || state.revision!==revision) stale();
    let hash=digest('');
    if (state.archived && !state.skip_memory) hash=await this.fingerprint(id);
    const current=memoryArchiveDb.get(id);
    if (!current || current.revision!==revision || !memoryArchiveDb.captured(id,revision,hash)) stale();
    if (state.archived && !state.skip_memory) memoryArchiveDb.rememberDigest(id,hash);
    return hash;
  }

  /** Catch-up uses content fingerprints, not timestamps alone, for a missed rearchive cycle. */
  async fingerprint(id:string): Promise<string> {
    let hash=digest('');
    for (const piece of await this.pieces(id)) hash=digest(`${hash}\n${piece}`);
    return hash;
  }

  async read(id: string, value: unknown) {
    const body=value as {archiveRevision?:unknown;contentRevision?:unknown;archived?:unknown;cursor?:unknown;checkpoint?:MemoryCheckpoint;verifyOnly?:unknown};
    if (!body || !/^[1-9][0-9]{0,14}$/.test(String(body.archiveRevision ?? '')) || !/^[a-f0-9]{64}$/.test(String(body.contentRevision ?? ''))
      || typeof body.archived!=='boolean' || (body.verifyOnly!==undefined && typeof body.verifyOnly!=='boolean')
      || (body.cursor!==undefined && (!Number.isSafeInteger(body.cursor) || Number(body.cursor)<0))) {
      throw new AppError('Invalid archive material request.',{statusCode:400});
    }
    const session=sessionsDb.getSessionById(id) ?? sessionsDb.getSessionByProviderSessionId(id);
    if (!session) throw new AppError('会话正文已不存在。',{code:'SESSION_NOT_FOUND',statusCode:404});
    const state=memoryArchiveDb.get(session.session_id);
    if (!state || String(state.revision)!==body.archiveRevision || Boolean(state.archived)!==body.archived
      || state.content_revision!==body.contentRevision || Boolean(session.isArchived)!==body.archived) stale();
    if (state.skip_memory && !body.verifyOnly) stale();
    const pieces=body.archived && !state.skip_memory ? await this.pieces(session.session_id) : [];
    const hashes=[digest('')];
    for (const piece of pieces) hashes.push(digest(`${hashes.at(-1)}\n${piece}`));
    if (hashes.at(-1)!==body.contentRevision || memoryArchiveDb.get(session.session_id)?.revision!==state.revision) stale();
    const details=this.reader.getSessionDetailsById(session.session_id);
    const identity={details:{...details,project:details.project ?? (session.project_path ? {path:session.project_path}:null)},
      provider:session.provider,nativeSessionId:session.provider_session_id ?? session.session_id,contentRevision:body.contentRevision,total:pieces.length,
      skipMemory:Boolean(state.skip_memory)};
    if (body.verifyOnly) return identity;
    let cursor=Number(body.cursor ?? 0);
    if (body.cursor===undefined && body.checkpoint) {
      const checkpoint=body.checkpoint;
      if (!Number.isSafeInteger(checkpoint.count) || checkpoint.count<0 || !/^[a-f0-9]{64}$/.test(checkpoint.digest)) throw new AppError('Invalid checkpoint.',{statusCode:400});
      // Rewritten/compacted history cannot masquerade as an append.
      cursor=hashes[checkpoint.count]===checkpoint.digest ? checkpoint.count : 0;
    }
    if (cursor>pieces.length) stale();
    const start=cursor, selected: string[]=[];
    let bytes=0;
    while (cursor<pieces.length && bytes+Buffer.byteLength(pieces[cursor])+1<=6000) {
      const piece=pieces[cursor++]; selected.push(piece);bytes+=Buffer.byteLength(piece)+1;
    }
    if (cursor===start && cursor<pieces.length) throw new AppError('会话分块超过额度。',{statusCode:413});
    return {...identity,start,transcript:selected.join('\n'),nextCursor:cursor<pieces.length ? cursor:null,
      checkpoint:{count:cursor,digest:hashes[cursor]}};
  }
}
