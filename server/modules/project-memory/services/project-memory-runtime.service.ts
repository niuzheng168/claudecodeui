import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { memoryArchiveDb, sessionsDb } from '@/modules/database/index.js';
import { codexThreadStatus, sessionsService, synchronizeMemoryArchives } from '@/modules/providers/index.js';
import { AppError } from '@/shared/index.js';

import { ProjectMemoryService } from './project-memory.service.js';
import { ArchiveMaterialService } from './archive-material.service.js';
import { ArchiveJobsService } from './archive-jobs.service.js';
import { MemoryHooksService } from './memory-hooks.service.js';
import { initializeSessionMemory, refreshSessionMemory } from './session-memory.service.js';

type PortalRequest = (method:string,path:string,options:{body?:unknown})=>Promise<unknown>;
let request: PortalRequest|undefined;
let accountOwner: string|undefined;
let nextIdentityCheck=0;
/** Routes and the runtime deliberately share one store/worker instance. */
export const projectMemoryStore=new ProjectMemoryService();
/** Signed source routes and the outbox share the same content-bound material reader. */
export const archiveMaterial=new ArchiveMaterialService();
/** Main's asynchronous acceptance never blocks the hook or the Portal request on a model. */
export const archiveJobs=new ArchiveJobsService(projectMemoryStore,(path,body) => {
  if (!request) throw new AppError('Codey Portal client unavailable.',{statusCode:503});
  return request('POST',path,{body});
},()=>accountOwner);
const hooks=new MemoryHooksService();
let timers: NodeJS.Timeout[]=[];
let unsubscribe: (()=>void)|undefined;
let sourceBusy=false, nextScan=0;
let integration: Record<string,unknown>={hooks:'not-started',nativeSync:'not-started'};
/** Owner-only memory listing reports hook installation and native archive availability honestly. */
export function memoryIntegrationStatus() { return integration; }

async function sourceTick() {
  if (sourceBusy || !request) return;
  sourceBusy=true;
  try {
    if (Date.now()>=nextIdentityCheck) {
      nextIdentityCheck=Date.now()+10000;
      try {
        const identity=await request('GET','/api/v1/me',{}) as {user?:{id?:unknown}};
        accountOwner=typeof identity.user?.id==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(identity.user.id) ? identity.user.id:undefined;
        if (accountOwner) nextIdentityCheck=Date.now()+60000;
      } catch { accountOwner=undefined; }
    }
    if (await hooks.takeWake() || Date.now()>=nextScan) {
      nextScan=Date.now()+60000;
      try { integration={...integration,nativeSync:await synchronizeMemoryArchives()}; }
      catch { integration={...integration,nativeSync:'unavailable-will-retry'}; }
    }
    for (const candidate of memoryArchiveDb.nativeRechecks()) {
      try {
        const hash=memoryArchiveDb.isMirror(candidate.provider,candidate.native_id) ? undefined
          : await archiveMaterial.fingerprint(candidate.session_id);
        memoryArchiveDb.finishNativeCheck(candidate.provider,candidate.native_id,candidate.activity,hash);
      } catch (error) {
        if ((error as AppError).statusCode===404) memoryArchiveDb.finishNativeCheck(candidate.provider,candidate.native_id,candidate.activity);
        // A missing/unavailable history must not block other source outbox entries.
      }
    }
    // An actual active turn is a restore, not an idle-time archive heuristic.
    for (const running of await sessionsService.listRunningSessions()) {
      if (running.background) continue;
      const row=sessionsDb.getSessionById(running.sessionId);
      if (row?.isArchived) sessionsDb.updateSessionIsArchived(row.session_id,false);
    }
    for (const state of memoryArchiveDb.pending()) {
      const row=sessionsDb.getSessionById(state.session_id);
      if (!row || !['claude','codex'].includes(row.provider)) { memoryArchiveDb.acknowledge(state.session_id,state.revision);continue; }
      if (memoryArchiveDb.isMirror(row.provider,row.provider_session_id ?? row.session_id)) {
        memoryArchiveDb.acknowledge(state.session_id,state.revision);continue;
      }
      try {
        const contentRevision=await archiveMaterial.capture(state.session_id,state.revision);
        await request('POST','/api/v1/memory/archive-events',{body:{
          eventId:createHash('sha256').update(`${state.session_id}/${state.revision}`).digest('hex'),
          provider:row.provider,sessionId:row.session_id,nativeSessionId:row.provider_session_id ?? row.session_id,
          archived:Boolean(state.archived),archiveRevision:String(state.revision),contentRevision,skipMemory:Boolean(state.skip_memory),
        }});
        memoryArchiveDb.acknowledge(state.session_id,state.revision);
      } catch { /* Durable latest-state outbox survives offline nodes, restores and restart. */ }
    }
  } finally { sourceBusy=false; }
}

/** The node entrypoint starts native hooks, source catch-up and main processing only on installed Codey nodes. */
export async function initializeProjectMemory(): Promise<void> {
  if (timers.length || !process.env.CODEY_PORTAL_CLIENT_MODULE) return;
  try {
    const module=await import(pathToFileURL(process.env.CODEY_PORTAL_CLIENT_MODULE).href) as {portalRequest?:PortalRequest};
    if (typeof module.portalRequest!=='function') return;
    request=module.portalRequest;
    memoryArchiveDb.initialize();
    integration={...integration,hooks:await hooks.install(await initializeSessionMemory(process.env.CODEY_PORTAL_CLIENT_MODULE))};
  } catch {
    request=undefined;integration={...integration,runtime:'unavailable-check-node-configuration'};
    console.warn('[Project memory] Initialization unavailable; native agent services were not changed.');
    return;
  }
  unsubscribe=codexThreadStatus.onArchiveChange((id,archived)=>memoryArchiveDb.observeNative('codex',id,archived));
  const safely=(work:()=>Promise<unknown>)=>{ void work().catch(()=>console.warn('[Project memory] Background processing will retry.')); };
  const refreshBriefs=async () => {
    try { await refreshSessionMemory();integration={...integration,sessionBriefs:'ready'}; }
    catch { integration={...integration,sessionBriefs:'offline-using-local-cache'}; }
  };
  timers=[setInterval(()=>safely(sourceTick),5000),setInterval(()=>safely(()=>archiveJobs.tick()),5000),
    setInterval(()=>safely(refreshBriefs),5*60*1000)];
  timers.forEach(timer=>timer.unref());
  safely(sourceTick);safely(()=>archiveJobs.tick());safely(refreshBriefs);
}
/** The node entrypoint stops schedulers without deleting jobs or interrupting native agent sessions. */
export function closeProjectMemory(): void {
  timers.forEach(timer=>clearInterval(timer));timers=[];unsubscribe?.();unsubscribe=undefined;accountOwner=undefined;
}
