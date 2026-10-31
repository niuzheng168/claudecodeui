import { createHash } from 'node:crypto';

import { AppError } from '@/shared/index.js';
import type { MemoryCheckpoint, ProjectMemoryJob } from '@/shared/index.js';

import { ProjectMemoryService } from './project-memory.service.js';

/** Main's durable job processor, shared by the thin job routes and node runtime. */
export class ArchiveJobsService {
  private busy=false;
  constructor(private readonly store: ProjectMemoryService,
    private readonly request: (path:string,body:unknown)=>Promise<unknown>,
    private readonly accountOwner?: ()=>string|undefined) {}

  async enqueue(owner:string,project:string,value:unknown) {
    const body=value as {jobId?:unknown;source?:ProjectMemoryJob['source']};
    const source=body?.source;
    if (!body || Object.keys(body).some(key=>!['jobId','source'].includes(key))
      || typeof body?.jobId!=='string' || !/^[a-f0-9]{64}$/.test(body.jobId) || !source
      || Object.keys(source).some(key=>!['nodeId','sessionId','nativeSessionId','provider','archiveRevision','contentRevision'].includes(key))
      || !/^n-[a-f0-9]{24}$/.test(source.nodeId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(source.sessionId)
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(source.nativeSessionId) || !['claude','codex'].includes(source.provider)
      || !/^[1-9][0-9]{0,14}$/.test(source.archiveRevision) || !/^[a-f0-9]{64}$/.test(source.contentRevision)) {
      throw new AppError('Invalid archive job.',{statusCode:400});
    }
    const previous=await this.store.job(owner,project,body.jobId);
    if (previous && JSON.stringify(previous.source)!==JSON.stringify(source)) throw new AppError('Job identity mismatch.',{statusCode:409});
    if (!previous) await this.store.job(owner,project,body.jobId,{
      jobId:body.jobId,owner,project,source,status:'queued',nextAt:Date.now(),attempts:0,
    });
    return {jobId:body.jobId,status:previous?.status ?? 'queued',contract:3};
  }
  async status(owner:string,project:string,id:string) {
    const job=await this.store.job(owner,project,id);
    if (!job) throw new AppError('No such memory job.',{statusCode:404});
    return {jobId:id,status:job.status,lastError:job.lastError ?? null,attempts:job.attempts};
  }
  async tick() {
    if (this.busy) return;
    const owner=this.accountOwner?.();
    if (this.accountOwner && !owner) return;
    this.busy=true;
    try {
      const selected=new Map<string,ProjectMemoryJob>();
      for (const job of (await this.store.pendingJobs(owner)).sort((a,b)=>a.nextAt-b.nextAt)) if (!selected.has(`${job.owner}/${job.project}`)) selected.set(`${job.owner}/${job.project}`,job);
      await Promise.all([...selected.values()].slice(0,2).map(job => this.process(job)));
    } finally { this.busy=false; }
  }
  private async process(job:ProjectMemoryJob) {
    const {owner,project,jobId,source}=job;
    const key=`${source.provider}/${source.nativeSessionId}`;
    const material=(body:unknown)=>this.request(`/api/v1/memory/jobs/${jobId}/material`,body);
    try {
      job.status='working';job.attempts+=1;
      await this.store.job(owner,project,jobId,job);
      let checkpoint=await this.store.checkpoint(owner,project,key);
      for (let batch=0;batch<4;batch++) {
        const page=await material({...(checkpoint?{checkpoint}:{})}) as {
          transcript:string;checkpoint:MemoryCheckpoint;nextCursor:number|null;start:number;contentRevision:string;
        };
        if (page.contentRevision!==source.contentRevision || typeof page.transcript!=='string'
          || !Number.isSafeInteger(page.start) || !Number.isSafeInteger(page.checkpoint?.count)
          || !/^[a-f0-9]{64}$/.test(page.checkpoint?.digest ?? '')) throw new AppError('Invalid source material.',{statusCode:503});
        if (page.transcript) {
          const facts=await this.store.extract(page.transcript);
          const eventId=createHash('sha256').update(`${jobId}:${page.start}:${page.checkpoint.digest}`).digest('hex');
          await this.store.summarize(owner,project,{eventId,source:`session:${source.nodeId}/${source.sessionId}`,transcript:facts.join('\n')},{
            checkpoint:{key,value:page.checkpoint},
            guard:async () => { await material({verifyOnly:true}); },
          });
        } else await material({verifyOnly:true});
        checkpoint=page.checkpoint;
        if (page.nextCursor===null) { job.status='done';break; }
        job.status='queued';
      }
      delete job.lastError;job.nextAt=Date.now()+5000;
    } catch (error) {
      const status=(error as {status?:number;statusCode?:number}).status ?? (error as AppError).statusCode;
      // Only a source/Portal fence can cancel; a model CAS conflict is retried.
      job.status=status===404 ? 'failed' : 'retrying';
      job.lastError=status===404 ? 'source_or_project_unavailable' : 'retry_pending';
      if (status===409) {
        try { await material({verifyOnly:true}); }
        catch (fence) {
          if (((fence as {status?:number}).status ?? (fence as AppError).statusCode)===409) { job.status='cancelled';job.lastError='archive_changed'; }
        }
      }
      job.nextAt=Date.now()+Math.min(1800000,10000*2**Math.min(job.attempts,8));
    }
    try { await this.store.job(owner,project,jobId,job); }
    catch (error) { if ((error as AppError).statusCode!==404) throw error; }
  }
}
