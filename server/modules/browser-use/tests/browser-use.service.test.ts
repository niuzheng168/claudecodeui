import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import { providerMcpService } from '@/modules/providers/index.js';

const OLD_TOKEN = 'old-token-value';
const NEW_TOKEN = 'new-token-value';
const NEW_API_URL = 'http://127.0.0.1:4321/api/browser-use-mcp';

const unrelatedServer = {
  type: 'stdio',
  command: '/usr/bin/node',
  args: ['/opt/agency/codey.mjs', 'agency', 'mcp', 'teams'],
  env: {},
};

const codeyEntry = (scriptPath: string, token = OLD_TOKEN) => ({
  type: 'stdio',
  command: '/usr/bin/node',
  args: [scriptPath],
  env: {
    CLOUDCLI_BROWSER_USE_MCP_TOKEN: token,
    CLOUDCLI_BROWSER_USE_API_URL: 'http://127.0.0.1:3001/api/browser-use-mcp',
  },
});

/**
 * Points every provider's config at a throwaway HOME. Provider MCP adapters
 * resolve os.homedir() per call, so nothing here touches the real configs.
 */
const withTempHome = async (run: (home: string) => Promise<void>) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-mcp-reconcile-'));
  const originalHomedir = os.homedir;
  (os as any).homedir = () => home;
  try {
    await run(home);
  } finally {
    (os as any).homedir = originalHomedir;
    await fs.rm(home, { recursive: true, force: true });
  }
};

const writeJson = async (filePath: string, data: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const readJson = async (filePath: string): Promise<any> => JSON.parse(await fs.readFile(filePath, 'utf8'));

const writeToml = async (filePath: string, data: Record<string, unknown>) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, TOML.stringify(data as never), 'utf8');
};

const readToml = async (filePath: string): Promise<any> => TOML.parse(await fs.readFile(filePath, 'utf8'));

/** Real provider MCP service with write calls counted, plus a captured logger. */
const createHarness = () => {
  const lines: string[] = [];
  const writes: string[] = [];
  return {
    lines,
    writes,
    logger: {
      log: (...parts: unknown[]) => lines.push(parts.join(' ')),
      warn: (...parts: unknown[]) => lines.push(parts.join(' ')),
    },
    mcp: {
      listMcpServersFromAllProviders: providerMcpService.listMcpServersFromAllProviders,
      upsertProviderMcpServer: async (
        ...input: Parameters<typeof providerMcpService.upsertProviderMcpServer>
      ) => {
        writes.push(`upsert:${input[0]}/${input[1].name}`);
        return providerMcpService.upsertProviderMcpServer(...input);
      },
      removeProviderMcpServer: async (
        ...input: Parameters<typeof providerMcpService.removeProviderMcpServer>
      ) => {
        writes.push(`remove:${input[0]}/${input[1].name}`);
        return providerMcpService.removeProviderMcpServer(...input);
      },
    },
  };
};

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('enabled Browser rewrites a stale registration once and leaves other servers alone', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const currentScript = path.join(home, 'releases', 'current', 'browser-use-mcp.js');
    await fs.mkdir(path.dirname(currentScript), { recursive: true });
    await fs.writeFile(currentScript, '', 'utf8');
    const staleScript = path.join(home, 'releases', 'deleted', 'browser-use-mcp.js');
    const claudeConfigPath = path.join(home, '.claude.json');
    await writeJson(claudeConfigPath, {
      numStartups: 7,
      mcpServers: {
        'cloudcli-browser': codeyEntry(staleScript),
        'cloudcli-browser-use': codeyEntry(staleScript),
        agency_teams: unrelatedServer,
      },
      projects: {
        '/work/app': { mcpServers: { 'cloudcli-browser': codeyEntry(staleScript) } },
      },
    });

    const harness = createHarness();
    const dependencies = {
      readSettings: () => ({ enabled: true }),
      getServerInput: () => ({
        command: process.execPath,
        args: [currentScript],
        env: { CLOUDCLI_BROWSER_USE_MCP_TOKEN: NEW_TOKEN, CLOUDCLI_BROWSER_USE_API_URL: NEW_API_URL },
      }),
      mcp: harness.mcp,
      logger: harness.logger,
    };
    await browserUseService.reconcileAgentMcp(dependencies);

    const claudeConfig = await readJson(claudeConfigPath);
    assert.deepEqual(claudeConfig.mcpServers['cloudcli-browser'], {
      type: 'stdio',
      command: process.execPath,
      args: [currentScript],
      env: { CLOUDCLI_BROWSER_USE_MCP_TOKEN: NEW_TOKEN, CLOUDCLI_BROWSER_USE_API_URL: NEW_API_URL },
    });
    assert.equal(claudeConfig.mcpServers['cloudcli-browser-use'], undefined);
    assert.deepEqual(claudeConfig.mcpServers.agency_teams, unrelatedServer);
    assert.equal(claudeConfig.numStartups, 7);
    // Local (per-project) scope shares the file but is not ours to rewrite.
    assert.deepEqual(claudeConfig.projects['/work/app'].mcpServers['cloudcli-browser'], codeyEntry(staleScript));

    // Every provider ends up registered, including ones that had no entry.
    const codexServer = (await readToml(path.join(home, '.codex', 'config.toml'))).mcp_servers['cloudcli-browser'];
    assert.equal(codexServer.command, process.execPath);
    assert.deepEqual(codexServer.args, [currentScript]);
    assert.equal(codexServer.env.CLOUDCLI_BROWSER_USE_MCP_TOKEN, NEW_TOKEN);

    assert.equal(harness.lines.length, 1);
    assert.match(harness.lines[0], /updated cloudcli-browser for claude, codex, cursor, opencode/);
    assert.match(harness.lines[0], /removed claude\/cloudcli-browser-use \(script missing\)/);
    assert.doesNotMatch(harness.lines[0], new RegExp(`${OLD_TOKEN}|${NEW_TOKEN}`));

    // A second start with nothing stale must not rewrite any provider config.
    const second = createHarness();
    await browserUseService.reconcileAgentMcp({ ...dependencies, mcp: second.mcp, logger: second.logger });
    assert.deepEqual(second.writes, []);
    assert.deepEqual(second.lines, []);
  });
});

test('disabled Browser removes Codey registrations whose script is gone from every provider', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const staleScript = path.join(home, 'releases', 'deleted', 'dist-server', 'browser-use-mcp.js');
    const claudeConfigPath = path.join(home, '.claude.json');
    await writeJson(claudeConfigPath, {
      mcpServers: {
        'cloudcli-browser': codeyEntry(staleScript),
        'cloudcli-browser-use': codeyEntry(staleScript),
        agency_teams: unrelatedServer,
      },
      projects: {
        '/work/app': { mcpServers: { 'cloudcli-browser': codeyEntry(staleScript) } },
      },
    });
    await writeJson(path.join(home, '.cursor', 'mcp.json'), {
      mcpServers: { 'cloudcli-browser': codeyEntry(staleScript), other: unrelatedServer },
    });
    await writeJson(path.join(home, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        'cloudcli-browser': {
          type: 'local',
          command: ['/usr/bin/node', staleScript],
          enabled: true,
          environment: codeyEntry(staleScript).env,
        },
      },
    });
    await writeToml(path.join(home, '.codex', 'config.toml'), {
      model: 'gpt-test',
      mcp_servers: {
        'cloudcli-browser': { command: '/usr/bin/node', args: [staleScript], env: codeyEntry(staleScript).env },
        other: { command: 'npx', args: ['-y', 'other-mcp'] },
      },
    });

    const harness = createHarness();
    await browserUseService.reconcileAgentMcp({
      readSettings: () => ({ enabled: false }),
      getServerInput: () => assert.fail('a disabled install must not mint a token or command'),
      mcp: harness.mcp,
      logger: harness.logger,
    });

    const claudeConfig = await readJson(claudeConfigPath);
    assert.deepEqual(claudeConfig.mcpServers, { agency_teams: unrelatedServer });
    assert.deepEqual(claudeConfig.projects['/work/app'].mcpServers['cloudcli-browser'], codeyEntry(staleScript));
    assert.deepEqual((await readJson(path.join(home, '.cursor', 'mcp.json'))).mcpServers, { other: unrelatedServer });
    assert.deepEqual((await readJson(path.join(home, '.config', 'opencode', 'opencode.json'))).mcp, {});
    const codexConfig = await readToml(path.join(home, '.codex', 'config.toml'));
    assert.equal(codexConfig.model, 'gpt-test');
    assert.deepEqual(Object.keys(codexConfig.mcp_servers), ['other']);

    assert.equal(harness.lines.length, 1);
    assert.match(harness.lines[0], /removed claude\/cloudcli-browser, claude\/cloudcli-browser-use, codex\/cloudcli-browser/);
    assert.doesNotMatch(harness.lines[0], new RegExp(OLD_TOKEN));
  });
});

test('disabled Browser keeps live and user-defined same-name registrations untouched', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const liveScript = path.join(home, 'releases', 'current', 'browser-use-mcp.js');
    await fs.mkdir(path.dirname(liveScript), { recursive: true });
    await fs.writeFile(liveScript, '', 'utf8');
    const claudeConfigPath = path.join(home, '.claude.json');
    const cursorConfigPath = path.join(home, '.cursor', 'mcp.json');
    const openCodeConfigPath = path.join(home, '.config', 'opencode', 'opencode.json');
    await writeJson(claudeConfigPath, {
      mcpServers: {
        'cloudcli-browser': codeyEntry(liveScript),
        // The CLI fallback form carries no script path to prove it broken.
        'cloudcli-browser-use': { type: 'stdio', command: 'cloudcli', args: ['browser-use-mcp'], env: {} },
      },
    });
    await writeJson(cursorConfigPath, {
      mcpServers: { 'cloudcli-browser': { command: 'npx', args: ['-y', '@someone/browser-mcp'], env: {} } },
    });
    await writeJson(openCodeConfigPath, {
      mcp: { 'cloudcli-browser': { type: 'remote', url: 'https://example.com/mcp', enabled: true } },
    });
    const before = await Promise.all([claudeConfigPath, cursorConfigPath, openCodeConfigPath]
      .map((filePath) => fs.readFile(filePath, 'utf8')));

    const harness = createHarness();
    await browserUseService.reconcileAgentMcp({
      readSettings: () => ({ enabled: false }),
      mcp: harness.mcp,
      logger: harness.logger,
    });

    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.lines, []);
    const after = await Promise.all([claudeConfigPath, cursorConfigPath, openCodeConfigPath]
      .map((filePath) => fs.readFile(filePath, 'utf8')));
    assert.deepEqual(after, before);
  });
});

test('reconcile failures are swallowed and never name config contents', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const staleScript = path.join(home, 'releases', 'deleted', 'browser-use-mcp.js');
    const claudeConfigPath = path.join(home, '.claude.json');
    await writeJson(claudeConfigPath, { mcpServers: { 'cloudcli-browser': codeyEntry(staleScript) } });
    const codexConfigPath = path.join(home, '.codex', 'config.toml');
    const brokenToml = 'api_key = "sk-secret-in-config" trailing garbage\n';
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fs.writeFile(codexConfigPath, brokenToml, 'utf8');

    // One unreadable provider config does not stop the others from being repaired.
    const harness = createHarness();
    await browserUseService.reconcileAgentMcp({
      readSettings: () => ({ enabled: false }),
      mcp: harness.mcp,
      logger: harness.logger,
    });
    assert.deepEqual((await readJson(claudeConfigPath)).mcpServers, {});
    assert.equal(await fs.readFile(codexConfigPath, 'utf8'), brokenToml);
    assert.equal(harness.lines.length, 2);
    assert.match(harness.lines[1], /for codex; left unchanged/);
    assert.doesNotMatch(harness.lines.join('\n'), /sk-secret-in-config/);

    const lines: string[] = [];
    await assert.doesNotReject(browserUseService.reconcileAgentMcp({
      readSettings: () => ({ enabled: true }),
      getServerInput: () => {
        throw new Error('database is locked');
      },
      logger: { log: () => undefined, warn: (...parts: unknown[]) => lines.push(parts.join(' ')) },
    }));
    assert.deepEqual(lines, ['[Browser] Could not reconcile agent MCP registration: database is locked']);
  });
});
