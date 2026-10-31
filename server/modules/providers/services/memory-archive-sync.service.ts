import { memoryArchiveDb, sessionsDb, getConnection } from '@/modules/database/index.js';

import { connectCodexNativeClient } from '../list/codex/codex-native-client.service.js';
import { synchronizeClaudeDesktopArchive, passOnClaudeDesktopArchive } from '../list/claude/claude-desktop-archive.service.js';

/**
 * Project-memory's hook wakeups and periodic catch-up use native archive
 * metadata. This reader never resumes a thread, guesses from absence or
 * modifies provider transcripts. First installation establishes a baseline.
 */
export async function synchronizeMemoryArchives(options: {
  connect?: typeof connectCodexNativeClient; syncClaude?: ()=>Promise<void>;
} = {}): Promise<{ codex: string; claude: string }> {
  const status={codex:'unavailable',claude:'desktop-sync'};
  if (options.syncClaude) await options.syncClaude();
  else {
    const claude=await synchronizeClaudeDesktopArchive();
    if (claude.passOn) await passOnClaudeDesktopArchive();
  }
  const client=await (options.connect ?? connectCodexNativeClient)();
  if (!client) return status;
  const baseline=!memoryArchiveDb.nativeBaselineComplete(), started=Date.now();
  try {
    for (const archived of [false,true]) {
      let cursor: string|undefined;
      const seen=new Set<string>();
      do {
        const page=await client.request('thread/list',{limit:100,archived,useStateDbOnly:true,...(cursor?{cursor}:{})});
        for (const thread of Array.isArray(page.data)?page.data:[]) {
          if (typeof thread?.id==='string' && typeof thread.cwd==='string' && thread.cwd
            && !sessionsDb.getSessionByProviderSessionId(thread.id) && !sessionsDb.isProviderSessionSuperseded(thread.id,'codex')) {
            // A conversation can be created and archived while this node is
            // offline. The ordinary active-thread discovery never sees it.
            getConnection().transaction(()=>{
              const time=(value:unknown)=>Number.isFinite(Number(value)) && Number(value)>0
                ? new Date(Number(value)*1000).toISOString():undefined;
              const id=sessionsDb.createSession(thread.id,'codex',thread.cwd,
                typeof thread.name==='string'?thread.name:'Codex',time(thread.createdAt),time(thread.updatedAt),
                typeof thread.path==='string'?thread.path:null);
              if (archived) {
                sessionsDb.updateSessionIsArchived(id,true);
                if (baseline) {
                  const state=memoryArchiveDb.get(id);
                  if (state) memoryArchiveDb.acknowledge(id,state.revision);
                }
              }
            })();
          }
          if (typeof thread?.id==='string') memoryArchiveDb.observeNative('codex',thread.id,archived,baseline,started,String(thread.updatedAt ?? ''));
        }
        cursor=typeof page.nextCursor==='string' && page.nextCursor ? page.nextCursor:undefined;
        if (cursor && seen.has(cursor)) throw new Error('Repeated archive cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    memoryArchiveDb.completeNativeBaseline();
    status.codex='native-archive-sync';
    return status;
  } finally { await client.close(); }
}
