import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { initializeDatabase, closeConnection, memoryArchiveDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';

import { ProjectMemoryService } from '../services/project-memory.service.js';
import { ArchiveMaterialService } from '../services/archive-material.service.js';
import { ArchiveJobsService } from '../services/archive-jobs.service.js';
import { MemoryHooksService } from '../services/memory-hooks.service.js';

const PROJECT=`p-${'a'.repeat(16)}`, NODE=`n-${'a'.repeat(24)}`;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const completed=(value:unknown)=>new Response(JSON.stringify({status:'completed',output:[{
  type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}],
}]}));

async function fixture(t:test.TestContext) {
  const root=await mkdtemp(path.join(os.tmpdir(),'archive-memory-'));
  const previous=process.env.DATABASE_PATH;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'auth.db');
  // An existing empty file prevents the legacy migrator from copying a user's database.
  await writeFile(process.env.DATABASE_PATH,Buffer.alloc(0));
  await initializeDatabase();
  sessionsDb.createSession('native-s','codex','/repo','Session');
  memoryArchiveDb.initialize();
  const data={messages:[] as Record<string,unknown>[],calls:[] as Record<string,any>[], failMerge:0,restoreOnMerge:false};
  const reader={
    getSessionDetailsById:sessionsService.getSessionDetailsById,
    fetchHistory:async (_id:string,options:{offset?:number;limit?:number})=>{
      const end=Math.max(0,data.messages.length-(options.offset ?? 0)),start=Math.max(0,end-(options.limit ?? 100));
      return {messages:data.messages.slice(start,end),hasMore:start>0,snapshotId:'test-snapshot'};
    },
  } as unknown as ConstructorParameters<typeof ArchiveMaterialService>[0];
  const material=new ArchiveMaterialService(reader);
  const dependencies={
    root:path.join(root,'accounts'),environment:{},
    modelEndpoint:()=>({url:'http://model.test/responses',headers:{}}),
    fetch:(async (_url,init)=>{
      const request=JSON.parse(String(init?.body));data.calls.push(request);
      const input=JSON.parse(request.input[0].content);
      if (request.instructions.startsWith('提取')) return completed({
        facts:input.transcript.split('\n').filter(Boolean).map((line:string)=>JSON.parse(line).text),
      });
      if (data.restoreOnMerge) { data.restoreOnMerge=false;sessionsDb.updateSessionIsArchived('native-s',false); }
      if (data.failMerge>0 && --data.failMerge===0) return new Response('unavailable',{status:503});
      const existing=input.memory.find((entry:{filename:string})=>entry.filename==='facts.md');
      return completed({upserts:[{
        id:existing?.id ?? null,...(existing?{version:existing.version}:{}),filename:'facts.md',kind:'fact',
        body:[existing?.body,input.transcript].filter(Boolean).join('\n'),
      }],remove:[]});
    }) as typeof fetch,
  };
  const store=new ProjectMemoryService(dependencies);
  const jobs=new Map<string,{archiveRevision:string;contentRevision:string}>();
  const request=async (route:string,body:unknown)=>{
    const id=route.split('/')[5];
    const job=jobs.get(id);
    if (!job) throw Object.assign(new Error('not found'),{status:404});
    try { return await material.read('native-s',{...(body as object),...job,archived:true}); }
    catch (error) { throw Object.assign(error as Error,{status:(error as {statusCode?:number}).statusCode}); }
  };
  const worker=new ArchiveJobsService(store,request);
  const add=(text:string,kind='text',role='user')=>data.messages.push({
    id:`message-${data.messages.length}`,kind,role,content:text,timestamp:new Date(1000*data.messages.length).toISOString(),
    sessionId:'native-s',provider:'codex',
  });
  const archive=async ()=>{
    sessionsDb.updateSessionIsArchived('native-s',true);
    const state=memoryArchiveDb.get('native-s')!;
    const contentRevision=await material.capture('native-s',state.revision);
    const archiveRevision=String(state.revision),jobId=sha(archiveRevision);
    jobs.set(jobId,{archiveRevision,contentRevision});
    await worker.enqueue('alice',PROJECT,{jobId,source:{nodeId:NODE,sessionId:'native-s',nativeSessionId:'native-s',provider:'codex',archiveRevision,contentRevision}});
    return {jobId,archiveRevision,contentRevision};
  };
  t.after(async ()=>{
    closeConnection();if (previous===undefined) delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;
    await rm(root,{recursive:true,force:true});
  });
  return {root,data,reader,material,store,worker,request,dependencies,add,archive};
}

test('baseline is silent; explicit archive, implicit reactivation and rearchive advance a durable generation',async t=>{
  await fixture(t);
  assert.equal(memoryArchiveDb.pending().length,0);
  sessionsDb.updateSessionIsArchived('native-s',true);
  const first=memoryArchiveDb.get('native-s')!;
  sessionsDb.updateSessionIsArchived('native-s',true);
  assert.equal(memoryArchiveDb.get('native-s')!.revision,first.revision);
  sessionsDb.createSession('native-s','codex','/repo','Continued');
  assert.equal(memoryArchiveDb.get('native-s')!.archived,0);
  sessionsDb.updateSessionIsArchived('native-s',true);
  const next=memoryArchiveDb.get('native-s')!;
  assert.equal(next.revision,first.revision+2);
  memoryArchiveDb.acknowledge('native-s',first.revision);
  assert.equal(memoryArchiveDb.pending().length,1,'an old acknowledgement cannot erase a newer transition');
});

test('native first discovery does not backfill; affirmative later archive/restore changes are carried once',async t=>{
  await fixture(t);
  memoryArchiveDb.observeNative('codex','native-s',false,true);
  assert.equal(memoryArchiveDb.pending().length,0);
  memoryArchiveDb.observeNative('codex','native-s',true);
  assert.equal(sessionsDb.getSessionById('native-s')!.isArchived,1);
  const revision=memoryArchiveDb.get('native-s')!.revision;
  memoryArchiveDb.observeNative('codex','native-s',true);
  assert.equal(memoryArchiveDb.get('native-s')!.revision,revision);
  memoryArchiveDb.observeNative('codex','native-s',false,false,0);
  assert.equal(sessionsDb.getSessionById('native-s')!.isArchived,1,'a stale list cannot undo a newer notification');
  memoryArchiveDb.observeNative('codex','native-s',false);
  assert.equal(sessionsDb.getSessionById('native-s')!.isArchived,0);
});

test('source pages all history, redacts credentials, excludes tools, and rejects changed snapshots',async t=>{
  const f=await fixture(t);
  for (let i=0;i<2105;i++) f.add(`fact-${i}`);
  f.add('reasoning-private','thinking','assistant');f.add('tool-private','tool_result','assistant');
  f.add('password=hidden Keep this fact');f.add('中文🙂'.repeat(1000));
  const event=await f.archive();
  let cursor: number|undefined,combined='',count=0;
  do {
    const page=await f.material.read('native-s',{...event,archived:true,...(cursor===undefined?{}:{cursor})});
    assert.ok('transcript' in page);
    combined+=page.transcript;count++;
    cursor=page.nextCursor ?? undefined;
  } while (cursor!==undefined);
  assert.ok(count>1);assert.match(combined,/fact-0/);assert.match(combined,/fact-2104/);
  assert.doesNotMatch(combined,/reasoning-private|tool-private|hidden|\\ufffd/);
  assert.match(combined,/credential omitted/);
  f.data.messages[0].content='rewritten';
  await assert.rejects(f.material.read('native-s',{...event,archived:true,verifyOnly:true}),{statusCode:409});
});

test('archive → active → rearchive processes only the successful suffix; unchanged rearchive calls no model',async t=>{
  const f=await fixture(t);
  f.add('first verified fact');
  const first=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,first.jobId)).status,'done');
  const calls=f.data.calls.length;
  sessionsDb.updateSessionIsArchived('native-s',false);
  const same=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,same.jobId)).status,'done');
  assert.equal(f.data.calls.length,calls);
  sessionsDb.updateSessionIsArchived('native-s',false);f.add('second verified fact');
  const next=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,next.jobId)).status,'done');
  const extracts=f.data.calls.filter(call=>call.instructions.startsWith('提取'));
  assert.equal(extracts.length,2);
  assert.doesNotMatch(JSON.parse(extracts[1].input[0].content).transcript,/first verified fact/);
  const files=(await f.store.list('alice',PROJECT)).memory;
  assert.equal(files.length,1);assert.equal(files[0].version,2);
  assert.match(files[0].body,/first verified fact/);assert.match(files[0].body,/second verified fact/);
});

test('reactivation during model inference fences the old result and leaves no successful checkpoint',async t=>{
  const f=await fixture(t);f.add('pending fact');f.data.restoreOnMerge=true;
  const old=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,old.jobId)).status,'cancelled');
  assert.equal((await f.store.list('alice',PROJECT)).memory.length,0);
  assert.equal(await f.store.checkpoint('alice',PROJECT,'codex/native-s'),undefined);
  f.add('continued fact');const next=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,next.jobId)).status,'done');
  assert.match((await f.store.list('alice',PROJECT)).memory[0].body,/pending fact/);
});

test('failed work resumes from its last committed prefix after reactivation and a worker restart',async t=>{
  const f=await fixture(t);
  for (let i=0;i<12;i++) f.add(`fact ${i} ${'a'.repeat(650)}`);
  f.data.failMerge=2;
  const old=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,old.jobId)).status,'retrying');
  const checkpoint=await f.store.checkpoint('alice',PROJECT,'codex/native-s');
  assert.ok(checkpoint && checkpoint.count>0 && checkpoint.count<12);
  sessionsDb.updateSessionIsArchived('native-s',false);f.add('last fact');
  const next=await f.archive();
  const restarted=new ArchiveJobsService(new ProjectMemoryService(f.dependencies),f.request);
  await restarted.tick();
  assert.equal((await restarted.status('alice',PROJECT,next.jobId)).status,'done');
  const content=(await f.store.list('alice',PROJECT)).memory[0].body;
  assert.equal(content.split('fact 0 ').length,2,'already committed facts are not appended twice');
  assert.match(content,/fact 11 /);assert.match(content,/last fact/);
});

test('rewritten history resets the prefix rather than silently skipping changed facts',async t=>{
  const f=await fixture(t);f.add('old fact');await f.archive();await f.worker.tick();
  sessionsDb.updateSessionIsArchived('native-s',false);f.data.messages[0].content='corrected fact';
  const event=await f.archive();
  const checkpoint=await f.store.checkpoint('alice',PROJECT,'codex/native-s');
  const page=await f.material.read('native-s',{...event,archived:true,checkpoint});
  assert.ok('start' in page);assert.equal(page.start,0);assert.match(page.transcript!,/corrected fact/);
});

test('catch-up detects an offline active/archive cycle from content, but not a title-only metadata update',async t=>{
  const f=await fixture(t);f.add('before offline');await f.archive();await f.worker.tick();
  memoryArchiveDb.observeNative('codex','native-s',true,true,undefined,'activity-1');
  const original=memoryArchiveDb.get('native-s')!.revision;
  f.add('work done while the node was offline');
  memoryArchiveDb.observeNative('codex','native-s',true,false,undefined,'activity-2');
  assert.equal(memoryArchiveDb.nativeRechecks().length,1);
  memoryArchiveDb.finishNativeCheck('codex','native-s','activity-2',await f.material.fingerprint('native-s'));
  assert.ok(memoryArchiveDb.get('native-s')!.revision>original);
  const event=await f.archive();await f.worker.tick();
  assert.equal((await f.worker.status('alice',PROJECT,event.jobId)).status,'done');
  assert.equal(f.data.calls.filter(call=>call.instructions.startsWith('提取')).length,2);
  const after=memoryArchiveDb.get('native-s')!.revision;
  memoryArchiveDb.observeNative('codex','native-s',true,false,undefined,'renamed-only');
  memoryArchiveDb.finishNativeCheck('codex','native-s','renamed-only',await f.material.fingerprint('native-s'));
  assert.equal(memoryArchiveDb.get('native-s')!.revision,after);
  memoryArchiveDb.setMirror('claude','remote-copy',true);
  assert.equal(memoryArchiveDb.isMirror('claude','remote-copy'),true);
  assert.equal(memoryArchiveDb.isMirror('claude','actual-source'),false);
});

test('hooks merge without overwriting user commands, are idempotent and only write a wake marker',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"memory-hooks-quote'-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.claude'),{recursive:true});
  await writeFile(path.join(root,'.claude','settings.json'),JSON.stringify({
    permissions:{deny:['Bash(rm *)']},hooks:{SessionEnd:[{hooks:[{type:'command',command:'echo user-hook'}]}]},
  }));
  const hooks=new MemoryHooksService(root,{});
  const states=await hooks.install();assert.match(states.codex,/trust/);
  await hooks.install();
  const config=JSON.parse(await readFile(path.join(root,'.claude','settings.json'),'utf8'));
  assert.deepEqual(config.permissions,{deny:['Bash(rm *)']});assert.equal(config.hooks.SessionEnd.length,2);
  const command=config.hooks.SessionEnd[1].hooks[0].command;
  await promisify(execFile)('bash',['-c',command]);
  assert.equal(await hooks.takeWake(),true);assert.equal(await hooks.takeWake(),false);
  await writeFile(path.join(root,'.codex','hooks.json'),'{ broken');
  assert.match((await hooks.install()).codex,/not-installed/);
  assert.equal(await readFile(path.join(root,'.codex','hooks.json'),'utf8'),'{ broken');
});

test('legacy hashed layout migrates once to stable owner paths, retaining a read-only rollback source',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'memory-migration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const legacyRoot=path.join(root,'legacy'),old=path.join(legacyRoot,PROJECT,sha('oldname').slice(0,32),'memory'),file=`${'b'.repeat(32)}.md`;
  await mkdir(old,{recursive:true});
  const entry={id:`m-${'b'.repeat(16)}`,filename:'architecture.md',kind:'fact',source:'user',mode:'manual',state:'adopted',version:1,createdAt:1000,updatedAt:1000,file,history:[]};
  await writeFile(path.join(old,file),'Existing architecture');
  await writeFile(path.join(old,'index.json'),JSON.stringify({revision:1,entries:[entry],receipts:{}}));
  const deps={root:path.join(root,'accounts'),legacyRoot,environment:{CODEY_PORTAL_USERNAME:'oldname'}};
  const store=new ProjectMemoryService(deps);
  assert.equal((await store.list('account-1',PROJECT)).memory[0].body,'Existing architecture');
  assert.match(await readFile(path.join(deps.root,'account-1','projects',PROJECT,'memory','topics','architecture.md'),'utf8'),/mode: manual/);
  await store.update('account-1',PROJECT,entry.id,{version:1,body:'Edited'});
  assert.equal((await new ProjectMemoryService(deps).list('account-1',PROJECT)).memory[0].body,'Edited');
  assert.equal(await readFile(path.join(old,file),'utf8'),'Existing architecture');
});

test('SQLite commit recovery rematerializes readable files and preserves replay receipts',async t=>{
  const f=await fixture(t);f.add('recoverable fact');const event=await f.archive();await f.worker.tick();
  const dir=path.join(f.dependencies.root,'alice','projects',PROJECT,'memory');
  await rm(path.join(dir,'topics','facts.md'));
  const db=new Database(path.join(dir,'index.sqlite'));
  db.prepare('DELETE FROM projection').run();db.prepare("INSERT OR REPLACE INTO metadata VALUES('dirty','1')").run();db.close();
  const restarted=new ProjectMemoryService(f.dependencies);
  await restarted.list('alice',PROJECT);
  assert.match(await readFile(path.join(dir,'topics','facts.md'),'utf8'),/recoverable fact/);
  assert.equal((await f.worker.status('alice',PROJECT,event.jobId)).status,'done');
  assert.equal((await readdir(dir)).some(name=>/^[a-f0-9]{32}\.md$/.test(name)),false);
});

test('more than 512 topics remain paged and old Chinese topics are retrieved without loading the whole library',async t=>{
  const f=await fixture(t);
  const target=(await f.store.create('alice',PROJECT,{filename:'超导部署.md',kind:'rule',body:'超导部署需要独立的回滚方案。',mode:'auto'})).memory;
  await f.store.create('alice',PROJECT,{filename:'unrelated.md',kind:'fact',body:'Unrelated information.',mode:'auto'});
  const dir=path.join(f.dependencies.root,'alice','projects',PROJECT,'memory');
  const db=new Database(path.join(dir,'index.sqlite'));
  const rows=db.prepare('SELECT value FROM entries').all() as {value:string}[];
  const template=rows.map(row=>JSON.parse(row.value)).find(entry=>entry.filename==='unrelated.md');
  db.transaction(()=>{
    for (let i=0;i<512;i++) {
      const id=`m-${i.toString(16).padStart(16,'0')}`,filename=`unrelated-${i}.md`;
      const entry={...template,id,filename,history:template.history.map((version:object)=>({...version,id,filename}))};
      db.prepare('INSERT INTO entries VALUES(?,?)').run(id,JSON.stringify(entry));
      db.prepare('INSERT INTO search VALUES(?,?)').run(id,`unrelated information ${i}`);
    }
    db.prepare("INSERT OR REPLACE INTO metadata VALUES('dirty','1')").run();
  })();db.close();
  const first=await f.store.list('alice',PROJECT);
  assert.equal(first.memory.length,100);assert.equal(first.total,514);assert.equal(first.nextCursor,100);
  assert.equal((await f.store.list('alice',PROJECT,500,first.revision)).memory.length,14);
  await f.store.create('alice',PROJECT,{filename:'new-topic.md',kind:'fact',body:'Works past the old file-count cap.'});
  await assert.rejects(f.store.list('alice',PROJECT,100,first.revision),{statusCode:409});
  await f.store.summarize('alice',PROJECT,{eventId:sha('old-topic-search'),source:`session:${NODE}/native-s`,transcript:'超导部署的回滚要求。'});
  const input=JSON.parse(f.data.calls.at(-1)!.input[0].content);
  assert.ok(input.memory.some((entry:{id:string})=>entry.id===target.id));
  assert.ok(input.memory.length<20);assert.ok(Buffer.byteLength(JSON.stringify(input))<24000);
});

test('quota failures preserve existing knowledge and remove uncommitted prepared files',async t=>{
  const f=await fixture(t);
  const store=new ProjectMemoryService({...f.dependencies,environment:{CODEY_MEMORY_QUOTA_BYTES:String(256*1024)}});
  const memory=(await store.create('alice',PROJECT,{filename:'keep.md',kind:'fact',body:'Keep this knowledge.'})).memory;
  let version=memory.version,failed=false;
  for (let i=0;i<10;i++) {
    try { await store.update('alice',PROJECT,memory.id,{version,body:`version ${i}\n${'x'.repeat(60000)}`});version++; }
    catch (error) { assert.equal((error as {statusCode:number}).statusCode,413);failed=true;break; }
  }
  assert.equal(failed,true);
  const current=(await store.history('alice',PROJECT,memory.id)).memory;
  assert.equal(current.version,version);
  const history=await readdir(path.join(f.dependencies.root,'alice','projects',PROJECT,'memory','.history'));
  assert.equal(history.length,version);
});
