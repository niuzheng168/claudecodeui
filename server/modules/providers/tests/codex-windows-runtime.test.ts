import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { CodexStdioPermissions } from '@/modules/providers/list/codex/codex-stdio-permissions.service.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord, ICodexRpcClient, IProviderRuntime, ProviderRuntimeContext } from '@/shared/index.js';

// A Node fixture, never a real Codex process or model. The persistent marker
// represents a native history that must retain its identity between children.
const server = `
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const log=(value)=>fs.appendFileSync(process.env.CODEY_STDIO_TEST_LOG,JSON.stringify({pid:process.pid,...value})+'\\n');
log({started:true,args:process.argv.slice(2),home:process.env.CODEX_HOME,
  inheritedThread:Boolean(process.env.CODEX_THREAD_ID),inheritedOrigin:Boolean(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE)});
const reply=(id,result)=>console.log(JSON.stringify({id,result}));
const nativeId='fixture-native-paginated';
const emit=(method,params)=>console.log(JSON.stringify({method,params:{threadId:nativeId,turnId:'owned-turn',...params}}));
rl.on('line',line=>{
 const r=JSON.parse(line); log(r); if(!r.method)return;
 if(r.method==='initialize')return reply(r.id,{});
 if(r.method==='initialized')return;
 if(r.method==='fixture/hang')return;
 if(r.method==='fixture/crash'){console.error('PRIVATE_STDERR_DO_NOT_EXPORT');return process.exit(3)}
 if(r.method==='fixture/request'){
  console.log(JSON.stringify({id:'native-approval',method:'item/commandExecution/requestApproval',
   params:{threadId:nativeId,turnId:'owned-turn',command:'echo fixture'}}));
  return reply(r.id,{});
 }
 if(r.method==='thread/start'){
  fs.writeFileSync('native-thread.json',JSON.stringify({id:nativeId,historyMode:'paginated'}));
  return reply(r.id,{thread:{id:nativeId,status:{type:'idle'}}});
 }
 if(r.method==='thread/resume'){
  if(process.env.CODEY_STDIO_TEST_MODE==='conflict')return console.log(JSON.stringify({id:r.id,error:{code:-32000,message:'thread-store conflict: thread already has an active writer'}}));
  return reply(r.id,{thread:{id:nativeId,status:{type:process.env.CODEY_STDIO_TEST_MODE==='busy'?'active':'idle'}}});
 }
 if(r.method==='turn/start'){
  // Notifications may precede the acknowledgement on a fast local transport.
  emit('item/started',{item:{id:'answer',type:'agentMessage',text:''}});
  emit('item/agentMessage/delta',{itemId:'answer',delta:'Windows continuation fixture'});
  emit('item/completed',{item:{id:'answer',type:'agentMessage',text:'Windows continuation fixture'}});
  emit('turn/completed',{turn:{id:'owned-turn',status:'completed'}});
  return reply(r.id,{turn:{id:'owned-turn'}});
 }
 reply(r.id,{});
});
rl.on('close',()=>setTimeout(()=>{log({exited:true});process.exit(0)},60));
`;

async function fixture(body: (f: { home: string; log: string; connect: () => Promise<CodexStdioClient> }) => Promise<void>) {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'codey-stdio-test-'));
  const home = path.join(root, 'home');
  const log = path.join(root, 'rpc.jsonl');
  const values: Record<string, string> = {
    CODEY_STDIO_TEST_LOG: log, CODEY_STDIO_TEST_MODE: '',
    CODEX_THREAD_ID: 'do-not-inherit', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'do-not-spoof-desktop',
  };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    await mkdir(home);
    await writeFile(path.join(home, 'package.json'), '{"type":"commonjs"}');
    await writeFile(path.join(home, 'app-server'), server);
    Object.assign(process.env, values);
    await body({
      home, log,
      connect: () => CodexStdioClient.connect({ executable: process.execPath, home, timeoutMs: 1500 }),
    });
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('codey-stdio-test-'));
    await rm(root, { recursive: true, force: true });
  }
}

async function records(log: string): Promise<AnyRecord[]> {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('owned stdio uses the explicit CLI/home, no listener, and does not inherit a desktop identity', { concurrency: false }, async () => {
  await fixture(async f => {
    const client = await f.connect();
    try {
      assert.equal(client.ownsProcess, true);
      await client.request('model/list', {});
    } finally { await client.close(); }
    const log = await records(f.log);
    assert.deepEqual(log[0].args, ['--stdio']);
    assert.equal(log[0].home, f.home);
    assert.equal(log[0].inheritedThread, false);
    assert.equal(log[0].inheritedOrigin, false);
    assert.deepEqual(log.filter(row => row.method).map(row => row.method), ['initialize', 'initialized', 'model/list']);
    assert.equal(log.at(-1)?.exited, true, 'close waits for the actual child exit');
    await assert.rejects(CodexStdioClient.connect({ executable: 'codex.exe', home: f.home }), { code: 'CODEX_STDIO_UNAVAILABLE' });
  });
});

test('stdio preserves server-request IDs and responds only once to an outstanding approval', { concurrency: false }, async () => {
  await fixture(async f => {
    const client = await f.connect();
    const ids: unknown[] = [];
    client.onServerRequest((_method, _params, id) => {
      ids.push(id);
      client.respondToServerRequest(id!, { result: { decision: 'decline' } });
      client.respondToServerRequest(id!, { result: { decision: 'accept' } });
    });
    try { await client.request('fixture/request', {}); } finally { await client.close(); }
    assert.deepEqual(ids, ['native-approval']);
    const replies = (await records(f.log)).filter(row => row.id === 'native-approval');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].result, { decision: 'decline' });
  });
});

test('a hung/crashed owned child fails without retrying or exporting stderr', { concurrency: false }, async () => {
  await fixture(async f => {
    for (const method of ['fixture/hang', 'fixture/crash']) {
      const client = await f.connect();
      try {
        await assert.rejects(client.request(method, {}), (error: unknown) => {
          const value = error as Error & { code?: string };
          return /^CODEX_STDIO_(TIMEOUT|DISCONNECTED)$/.test(value.code || '')
            && !value.message.includes('PRIVATE_STDERR');
        });
      } finally { await client.close(); }
    }
    const log = await records(f.log);
    for (const method of ['fixture/hang', 'fixture/crash']) {
      assert.equal(log.filter(row => row.method === method).length, 1);
    }
  });
});

test('two Windows turns reuse one native ID, never fork/exec, and release the writer before completion', { concurrency: false }, async () => {
  await fixture(async f => {
    let nativeId: string | null = null;
    const messages: AnyRecord[] = [];
    const fallback: IProviderRuntime = { run: async () => { assert.fail('No exec fallback'); }, abort: () => false };
    const provider = new CodexSessionsProvider();
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => nativeId, resolveResumeModel: async () => 'fixture-model',
      getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }),
      normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id),
      isProviderInstalled: async () => true,
    };
    let closed = false;
    const runtime = new CodexSharedRuntime(fallback, async () => {
      closed = false;
      const client = await f.connect();
      const close = client.close.bind(client);
      client.close = async () => { await close(); closed = true; };
      return client;
    });
    const writer = {
      isWebSocketWriter: true, setSessionId: (id: string) => { nativeId = id; },
      send: (value: unknown) => {
        const message = value as AnyRecord;
        if (message.kind === 'complete') assert.equal(closed, true);
        messages.push(message);
      },
    };
    for (const command of ['First prompt', 'Continue the existing thread']) {
      await runtime.run(command, { sessionId: 'app-session', cwd: f.home }, writer, context);
    }
    assert.equal(nativeId, 'fixture-native-paginated');
    assert.equal(messages.filter(row => row.kind === 'complete' && row.success).length, 2);
    const log = await records(f.log);
    assert.equal(log.filter(row => row.method === 'thread/start').length, 1);
    assert.equal(log.filter(row => row.method === 'thread/resume').length, 1);
    assert.equal(log.filter(row => row.method === 'turn/start').length, 2);
    assert.ok(!log.some(row => row.method === 'thread/fork'));
    for (const mode of ['busy', 'conflict']) {
      process.env.CODEY_STDIO_TEST_MODE = mode;
      await runtime.run('Must not take over', { sessionId: 'app-session', cwd: f.home }, writer, context);
      assert.equal(messages.at(-1)?.success, false);
    }
    assert.equal((await records(f.log)).filter(row => row.method === 'turn/start').length, 2);
  });
});

test('owned approvals are one-shot and cannot approve another desktop/client or silently amend policy', () => {
  const permissions = new CodexStdioPermissions();
  const replies: AnyRecord[] = [], messages: AnyRecord[] = [];
  const client = {
    ownsProcess: true,
    respondToServerRequest: (id: unknown, reply: unknown) => replies.push({ id, reply }),
  } as unknown as ICodexRpcClient;
  const writer = { isWebSocketWriter: true, send: (value: unknown) => messages.push(value as AnyRecord) };
  const params = { threadId: 'native', turnId: 'turn', command: 'echo example' };
  try {
    permissions.handle(client, 'app', 'native', 'item/commandExecution/requestApproval', params, 0, writer);
    const requestId = messages.at(-1)!.requestId;
    assert.equal(permissions.gateway.listPending('app').length, 1);
    assert.equal(permissions.gateway.listPending('someone-else').length, 0);
    assert.throws(() => permissions.gateway.resolve(requestId, { allow: true, rememberEntry: '*' }), { code: 'CODEX_APPROVAL_EDIT_UNSUPPORTED' });
    permissions.gateway.resolve(requestId, { allow: true });
    permissions.gateway.resolve(requestId, { allow: true });
    assert.deepEqual([...replies], [{ id: 0, reply: { result: { decision: 'accept' } } }]);
    permissions.handle({ ...client, ownsProcess: false }, 'app', 'native', 'item/fileChange/requestApproval', params, 3, writer);
    assert.equal(permissions.gateway.listPending('app').length, 0);
    permissions.handle(client, 'app', 'native', 'item/tool/requestUserInput', params, 4, writer);
    assert.equal(replies.at(-1)?.reply.error.code, -32601, 'Unsupported interactions must not hang or auto-approve');
    permissions.handle(client, 'app', 'native', 'item/permissions/requestApproval',
      { ...params, permissions: { network: { enabled: true } } }, 5, writer);
    permissions.gateway.resolve(messages.at(-1)!.requestId, { allow: false });
    assert.deepEqual(replies.at(-1)?.reply.result, { permissions: {}, scope: 'turn' });
    permissions.handle(client, 'app', 'native', 'item/fileChange/requestApproval', params, 6, writer);
    permissions.cancel('app', client);
    assert.equal(permissions.gateway.listPending('app').length, 0);
    assert.equal(messages.at(-1)?.kind, 'permission_cancelled');
  } finally { permissions.cancel('app', client); }
});
