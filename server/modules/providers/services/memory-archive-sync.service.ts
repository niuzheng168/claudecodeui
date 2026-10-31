import { memoryArchiveDb } from '@/modules/database/index.js';

import { connectCodexNativeClient } from '../list/codex/codex-native-client.service.js';
import { synchronizeClaudeDesktopArchive, passOnClaudeDesktopArchive } from '../list/claude/claude-desktop-archive.service.js';

/**
 * Project-memory's hook wakeups and periodic catch-up use native archive
 * metadata. This reader never resumes a thread, guesses from absence or
 * modifies provider transcripts. First installation establishes a baseline.
 */
export async function synchronizeMemoryArchives(): Promise<{ codex: string; claude: string }> {
  const status={codex:'unavailable',claude:'desktop-sync'};
  const claude=await synchronizeClaudeDesktopArchive();
  if (claude.passOn) await passOnClaudeDesktopArchive();
  const client=await connectCodexNativeClient();
  if (!client) return status;
  const baseline=!memoryArchiveDb.nativeBaselineComplete(), started=Date.now();
  try {
    for (const archived of [false,true]) {
      let cursor: string|undefined;
      const seen=new Set<string>();
      do {
        const page=await client.request('thread/list',{limit:100,archived,useStateDbOnly:true,...(cursor?{cursor}:{})});
        for (const thread of Array.isArray(page.data)?page.data:[]) {
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
