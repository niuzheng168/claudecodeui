import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeExecutableOption } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { codeyClaudeGateway } from '@/modules/providers/services/codey-claude-gateway.service.js';

/** A Claude Code command Codey offers in a Claude chat's slash menu. */
type ClaudeNativeCommand = {
  /** Slash-prefixed, as typed: `/compact`. */
  name: string;
  description: string;
};

/**
 * Claude Code commands that do what they say when Codey sends them as a chat
 * message. Codey runs every turn in a fresh CLI process over the SDK's
 * streaming input, which rules out part of what the CLI reports. Measured
 * against the bundled CLI:
 * - `compact` and `context` run locally and answer within the turn;
 * - prompt commands and bundled skills expand into an ordinary model turn;
 * - `usage` (`cost`, `stats`) only counts the current process, which has
 *   spent nothing yet;
 * - `clear` moves the CLI to a new session the Codey session never follows;
 * - `heapdump`, `reload-skills` and `debug` act on the process itself, which
 *   is gone by the next turn;
 * - `loop` schedules wake-ups that outlive the turn's process, and `insights`
 *   writes a report for a local terminal user;
 * - `goal` is Codey's Codex command.
 * Anything not listed, including the user's own skills and commands, comes
 * from Codey's other command sources.
 */
const CLAUDE_NATIVE_COMMAND_NAMES = new Set([
  'compact',
  'context',
  'init',
  'review',
  'security-review',
  'code-review',
  'simplify',
  'verify',
  'batch',
  'deep-research',
  'claude-api',
  'update-config',
  'fewer-permission-prompts',
  'run',
  'run-skill-generator',
  'team-onboarding',
]);

const DISCOVERY_TIMEOUT_MS = 15_000;
// The first menu after a server start waits this long for discovery, then
// shows the built-ins alone; the cache is filled for the next one.
const LIST_WAIT_MS = 4_000;
// The CLI only changes with a Codey update (or an operator swapping
// CLAUDE_CLI_PATH), so a cached list is refreshed rarely, in the background.
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;

/**
 * Asks the Claude Code CLI which slash commands it supports, without a turn.
 * Used by the native commands service below, and exported for its tests
 * against a stand-in CLI.
 *
 * The CLI is started on a streaming input that never yields, reports its
 * commands while initializing, and is closed before it could call a model.
 * With no setting sources it runs none of the user's hooks or plugins and
 * reports only its built-in commands and bundled skills.
 */
export async function discoverClaudeSlashCommands(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<SlashCommand[]> {
  let releaseInput = () => {};
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        releaseInput = () => resolve({ done: true, value: undefined });
      }),
    }),
  };
  const executable = resolveClaudeExecutableOption();
  const session = query({
    prompt: input,
    options: {
      cwd: os.tmpdir(),
      env: codeyClaudeGateway.buildEnvironment(),
      settingSources: [],
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      session.supportedCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    releaseInput();
    session.close();
  }
}

/** Keeps the verified commands, in the CLI's order, under their slash names. */
function selectNativeCommands(supported: SlashCommand[]): ClaudeNativeCommand[] {
  return supported
    .filter((command) => CLAUDE_NATIVE_COMMAND_NAMES.has(command.name))
    .map((command) => ({ name: `/${command.name}`, description: command.description }));
}

/**
 * Lists Claude Code's own commands for Claude chats; the shared instance
 * below serves the Commands router, and tests inject discovery and a clock.
 * Discovery starts a CLI process, so it runs once per server process and is
 * cached; a failure lists nothing and is retried after a pause rather than on
 * every menu.
 */
export function createClaudeNativeCommandsService(dependencies: {
  discover?: () => Promise<SlashCommand[]>;
  now?: () => number;
} = {}) {
  const discover = dependencies.discover ?? (() => discoverClaudeSlashCommands());
  const now = dependencies.now ?? Date.now;
  let commands: ClaudeNativeCommand[] | null = null;
  let discoveredAt = 0;
  let failedAt = Number.NEGATIVE_INFINITY;
  let discovery: Promise<ClaudeNativeCommand[] | null> | null = null;

  const refresh = (): Promise<ClaudeNativeCommand[] | null> => {
    discovery ??= Promise.resolve()
      .then(discover)
      .then((supported) => {
        commands = selectNativeCommands(supported);
        discoveredAt = now();
        return commands;
      })
      .catch((error: unknown) => {
        failedAt = now();
        console.warn('[Claude] Could not list Claude Code slash commands:', error instanceof Error ? error.message : error);
        return null;
      })
      .finally(() => {
        discovery = null;
      });
    return discovery;
  };

  return {
    async list(waitMs = LIST_WAIT_MS): Promise<ClaudeNativeCommand[]> {
      if (commands) {
        if (now() - discoveredAt >= REFRESH_AFTER_MS) {
          void refresh();
        }
        return commands;
      }
      if (!discovery && now() - failedAt < RETRY_AFTER_MS) {
        return [];
      }

      let timer: NodeJS.Timeout | undefined;
      const discovered = await Promise.race([
        refresh(),
        new Promise<null>((resolve) => {
          timer = setTimeout(resolve, waitMs, null);
        }),
      ]);
      clearTimeout(timer);
      return discovered ?? [];
    },
  };
}

/** Used by the Commands router (through the providers barrel) for the lifetime of the server process. */
export const claudeNativeCommandsService = createClaudeNativeCommandsService();
