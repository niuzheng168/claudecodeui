import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * The node runtime installs additive user hooks. A hook writes one wake marker,
 * not a transcript or archive assertion, and never needs network credentials.
 * Codex hook trust remains a user's decision; the installer does not bypass it.
 */
export class MemoryHooksService {
  readonly root: string;
  constructor(private readonly home = os.homedir(), private readonly environment = process.env) {
    this.root=path.join(home,'.codey','hooks');
  }
  async install() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    const script=path.join(this.root,'project-memory-hook.mjs');
    const wake=path.join(this.root,'archive-wake');
    const source=`import {writeFile,rename} from 'node:fs/promises';\nimport {randomBytes} from 'node:crypto';\nconst file=${JSON.stringify(wake)};\nconst tmp=file+'.'+randomBytes(8).toString('hex');\ntry { await writeFile(tmp,String(Date.now()),{mode:0o600});await rename(tmp,file); } catch {}\n`;
    await this.atomic(script,source);
    const quote=(value:string) => process.platform==='win32' ? `"${value.replaceAll('"','\\\\"')}"` : `'${value.replaceAll("'","'\\''")}'`;
    const command=`${quote(process.execPath)} ${quote(script)}`;
    const managedScript=quote(script);
    const states: Record<string,string>={};
    for (const [provider,file] of [
      ['codex',path.join(this.environment.CODEX_HOME ?? path.join(this.home,'.codex'),'hooks.json')],
      ['claude',path.join(this.environment.CLAUDE_CONFIG_DIR ?? path.join(this.home,'.claude'),'settings.json')],
    ]) {
      try {
        const old=await readFile(file,'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code==='ENOENT') return ''; throw error;
        });
        const config=old ? JSON.parse(old) : {};
        if (!config || typeof config!=='object' || Array.isArray(config)
          || (config.hooks!==undefined && (!config.hooks || typeof config.hooks!=='object' || Array.isArray(config.hooks)))) throw new Error('Invalid hook settings');
        config.hooks ??= {};
        for (const event of ['SessionEnd','SessionStart']) {
          const groups=config.hooks[event] ?? [];
          if (!Array.isArray(groups) || groups.some(group=>!group || typeof group!=='object' || Array.isArray(group)
            || !Array.isArray(group.hooks) || group.hooks.some((hook:unknown)=>!hook || typeof hook!=='object' || Array.isArray(hook)))) {
            throw new Error('Invalid hook group');
          }
          const others=groups.filter(group => !Array.isArray(group?.hooks)
            || !group.hooks.some((hook: {command?:unknown}) => typeof hook.command==='string' && hook.command.includes(managedScript)));
          // Keep unrelated commands even when someone put them in the same group.
          for (const group of groups.filter(group => !others.includes(group))) {
            const hooks=group.hooks.filter((hook: {command?:unknown}) => typeof hook.command!=='string' || !hook.command.includes(managedScript));
            if (hooks.length) others.push({...group,hooks});
          }
          config.hooks[event]=[...others,{hooks:[{type:'command',command,timeout:2}]}];
        }
        const next=`${JSON.stringify(config,null,2)}\n`;
        if (next!==old) {
          await mkdir(path.dirname(file),{recursive:true,mode:0o700});
          if (old) await this.atomic(path.join(this.root,`${provider}-backup-${createHash('sha256').update(old).digest('hex').slice(0,16)}.json`),old);
          if (await readFile(file,'utf8').catch(() => '')!==old) throw new Error('Settings changed concurrently');
          await this.atomic(file,next);
        }
        states[provider]=provider==='codex' ? 'installed-review-trust-in-codex' : 'installed';
      } catch { states[provider]='not-installed-check-existing-settings'; }
    }
    return states;
  }
  async takeWake(): Promise<boolean> {
    const consumed=path.join(this.root,`archive-wake-${randomBytes(8).toString('hex')}`);
    try { await rename(path.join(this.root,'archive-wake'),consumed); await rm(consumed);return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error; }
  }
  private async atomic(file:string,body:string) {
    const temporary=`${file}.${randomBytes(8).toString('hex')}.tmp`;
    try { await writeFile(temporary,body,{mode:0o600,flag:'wx'});await rename(temporary,file); }
    finally { await rm(temporary,{force:true}); }
  }
}
