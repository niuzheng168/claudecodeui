# Providers Module Guide

This file documents the current provider contract in `server/modules/providers`.
Keep it current whenever provider wiring, skill discovery, or session sync
behavior changes. The goal is that a human or AI agent can add a new provider
without guessing which files need to move.

## Current Provider Shape

Every provider wrapper exposes seven facets:

- `runtime`
- `models`
- `auth`
- `mcp`
- `skills`
- `sessions`
- `sessionSynchronizer`

These correspond to the shared interfaces in `server/shared/interfaces.ts`:

- `IProviderRuntime`
- `IProviderModels`
- `IProviderAuth`
- `IProviderMcp`
- `IProviderSkills`
- `IProviderSessions`
- `IProviderSessionSynchronizer`

The services that consume them are:

- `providerModelsService`
- `providerAuthService`
- `providerMcpService`
- `providerSkillsService`
- `sessionsService`
- `sessionSynchronizerService`

Live execution is consumed through `providerRuntimeService`, which resolves the
provider-owned runtime through the same `providerRegistry` as every other facet.

### Codex native goal and planning commands

The command catalog advertises `/goal` and `/plan` only for Codex. Goal creation
and resume use the ordinary session-allocated chat gateway, not a detached REST
model call. `CodexGoalRun` follows `thread/goal/*` and multiple native turns until
the goal is inactive and its current turn has drained. Stop pauses the scheduler
before interrupting the tracked turn; failures never replay an activation.

`codexCommandsService` exposes read/pause/clear/edit/budget controls through the
Providers barrel. It resolves app session ids from the database before calling
the runtime's owning connection. Controls do not resume a thread, and a separate
client cannot take over an already-active goal by sending a new goal command.

The composer represents Plan Mode using its existing mode selector and sends an
explicit `codexPlanMode` boolean with Codex messages. Native execution translates
this into `collaborationMode` with built-in instructions, plus a read-only sandbox
for planning. Explicitly leaving Plan Mode also uses native RPC rather than
silently relying on exec defaults. Owned stdio connections translate
`item/tool/requestUserInput` into the existing web question UI with stable native
question ids; desktop-owned interactions retain their existing owner.

On CLI-only nodes, native commands/mode selections use a scoped app-server child
from the configured CLI (or the installed npm launcher in source development).
New CLI-only threads retain legacy history compatibility. Existing daemon and
Windows transport selection, writer-conflict protection and no-retry behavior
remain in force. The opt-in `codex-native-commands.integration.test.ts` verifies
real CLI behavior using an isolated home and offline localhost model fixture.

### Codex active desktop turns

Ordinary messages sent while the shared daemon is running a desktop turn use
`turn/steer`, not another `turn/start`. The adapter verifies the thread and
newest active turn, pins `expectedTurnId`, and follows that turn's output with
the existing model, permissions and mode. Further same-turn corrections are
available; an explicit run-bound Stop can interrupt that verified turn, but
automatic cleanup and approvals remain with the desktop owner. Lost/stale
acknowledgements never cause a retry, fork, or exec fallback.

Private stdio backends (including macOS) discover an existing desktop IPC owner
before resuming ordinary shared threads, so Codey does not take the writer from
an idle desktop window. Owner-pinned live snapshots enable prompt-free
observation, queued-card steering and explicit Stop. The helper reads complete
native turn pages without loading a thread; desktop and Codey inputs retain
their receipt identities and transcript positions in both views. The desktop
steering protocol selects its active turn internally: Codey checks fresh state
before dispatch and verifies the returned turn ID, treating rollover/ambiguous
receipts as unconfirmed without replay. Its Stop protocol has an expected-turn
guard. Older/no-peer foreign-writer sessions keep the native queue fallback
without advertising unsupported controls.

Each browser send and accepted correction now carries its own input identity
through native `clientUserMessageId`, history `clientId` (legacy `client_id`),
and normalized `clientMessageId`. The browser reconciles by that receipt, not
the desktop turn's start time or matching text. This requires both the backend
and shared Workspace UI update; intentional identical messages remain separate.

Current provider ids in this repo are:

- `claude`
- `codex`
- `cursor`
- `opencode`

Those ids are mirrored in backend unions and frontend provider constants. If
adding a new provider, update every place that hardcodes this list.

## Current File Layout

Each provider lives under its own folder in `server/modules/providers/list/`:

```text
server/modules/providers/list/<provider>/
  <provider>.provider.ts
  <provider>-runtime.provider.js
  <provider>-auth.provider.ts
  <provider>-models.provider.ts
  <provider>-mcp.provider.ts
  <provider>-skills.provider.ts
  <provider>-sessions.provider.ts
  <provider>-session-synchronizer.provider.ts
```

The existing provider folders are `claude`, `codex`, `cursor`, and `opencode`.

Each provider wrapper owns its SDK/CLI runtime alongside its auth, model, and
session facets. Runtime adapters receive registry-backed model and session
lookups from `providerRuntimeService` at execution time instead of importing
those services themselves. This keeps `providerRegistry` as the only provider
mapping without creating a circular dependency. Application-level consumers
import the service from `server/modules/providers/index.ts`.

## What Each Facet Does

| Facet | Responsibility | Base / Service |
| --- | --- | --- |
| `runtime` | Run and abort live SDK/CLI sessions | `IProviderRuntime` -> `providerRuntimeService` |
| `models` | Resolve supported and active models | `IProviderModels` -> `providerModelsService` |
| `auth` | Report install/auth state for the provider runtime | `IProviderAuth` -> `providerAuthService` |
| `mcp` | Read, list, write, and remove provider-native MCP config | `McpProvider` -> `providerMcpService` |
| `skills` | Discover provider-native skill markdown files | `SkillsProvider` -> `providerSkillsService` |
| `sessions` | Normalize live events and fetch session history | `IProviderSessions` -> `sessionsService` |
| `sessionSynchronizer` | Scan transcript artifacts and upsert session metadata | `IProviderSessionSynchronizer` -> `sessionSynchronizerService` |

`sessions` and `sessionSynchronizer` are separate concerns:

- `sessions` handles runtime event normalization and history fetches.
- `sessionSynchronizer` handles file-backed session indexing into `sessionsDb`.

## Codex native session interoperability

Linux, macOS and Windows share `connectCodexNativeClient` for execution,
discovery and native history. Prefer the existing app-server socket. If its
default socket is absent, use the absolute `CODEY_CODEX_EXECUTABLE` with the
same `CODEX_HOME`. Explicit `CODEY_CODEX_RUNTIME_TRANSPORT=stdio` is supported
on every platform; an explicit socket and stdio selection are mutually
exclusive. An unavailable explicit socket or failed native handshake never
selects another runtime.

Native `thread/start`/`thread/resume` preserve the original provider ID and
normal source metadata. On the exact native `thread/resume` writer refusal,
the helper verifies the desktop thread and queues the input once through
`thread/queue/add`; it never deletes a lock, forks the conversation, or retries
an ambiguous submission. Queued turns inherit the owner's model/permissions,
and desktop approvals and interruption of started queue work remain there.

Discovery includes native-only threads without a JSONL export. History and
queued output use full native turn pages, including for legacy histories that
do not support item pagination. Read-only helpers verify that they loaded no
thread and await their own exit. Partial JSONL exports cannot substitute for
native history. Only unconfigured legacy installations retain SDK fallback.

Tests include cross-platform transport selection, mocked native owners and
opt-in offline real-CLI round trips (`CODEY_TEST_NATIVE_INTEROP=1` plus an
absolute `CODEY_TEST_CODEX_EXECUTABLE`; optionally set
`CODEY_TEST_CODEX_OWNER_EXECUTABLE` to exercise desktop/CLI version skew).
These never use user conversations or real model credentials.
This change requires deploying the node backend, not
just publishing the shared frontend.

## How To Add A Provider

1. Add the provider id everywhere it is part of the contract.

- Update `server/shared/types.ts` `LLMProvider`.
- Update `src/types/app.ts` `LLMProvider` if the frontend should know about it.
- Update `server/modules/providers/provider.routes.ts`.
- Update `server/modules/agent/agent.routes.ts` if the provider is launchable from the agent runtime.
- Update `server/index.ts` if the provider needs runtime boot or shutdown wiring.
- Update the `PROVIDER_ORDER` list in `public/api-docs.html` if the provider should appear in the public API docs.
- Update `src/components/chat/hooks/useChatProviderState.ts` and
  `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx` if
  the provider should be selectable in chat.
- Update `src/components/provider-auth/view/ProviderLoginModal.tsx` if the
  provider has a login/setup flow.

2. Create the wrapper class.

- Add `server/modules/providers/list/<provider>/<provider>.provider.ts`.
- Add `server/modules/providers/list/<provider>/<provider>-runtime.provider.js`
  when the provider supports live SDK/CLI execution.
- Extend `AbstractProvider`.
- Expose readonly `auth`, `mcp`, `skills`, `sessions`, and `sessionSynchronizer`.
- Call `super('<provider>')`.

3. Implement auth.

- Return a full `ProviderAuthStatus`.
- Treat normal `not installed` / `not authenticated` states as data, not exceptions.
- Keep provider-specific credential discovery inside the auth provider.
- If the provider has no auth step, return a stable unauthenticated or not-installed status instead of omitting the facet.

4. Implement MCP.

- Extend `McpProvider`.
- Pass the supported scopes and transports to `super(...)`.
- Implement the four required methods:
  - `readScopedServers(...)`
  - `writeScopedServers(...)`
  - `buildServerConfig(...)`
  - `normalizeServerConfig(...)`
- Use the shared validation and normalization behavior from `McpProvider`.
- Keep the provider-specific config format local to the provider implementation.

Current MCP formats in this repo are:

| Provider | User / Project Storage | Supported Scopes | Supported Transports |
| --- | --- | --- | --- |
| Claude | `.mcp.json` in user / local / project locations | `user`, `local`, `project` | `stdio`, `http`, `sse` |
| Codex | `.codex/config.toml` | `user`, `project` | `stdio`, `http` |
| Cursor | `.cursor/mcp.json` | `user`, `project` | `stdio`, `http` |
| OpenCode | `~/.config/opencode/opencode.json` or `<workspace>/opencode.json` (`.jsonc` is read when present) | `user`, `project` | `stdio`, `http` |

5. Implement skills.

- Extend `SkillsProvider`.
- Implement `getSkillSources(workspacePath)`.
- Return the actual discovery roots for the provider.
- Skills are discovered from `SKILL.md` files.
- `readProviderSkillMarkdownDefinition(...)` reads front matter `name` and `description`.
- If `name` is missing, the parent directory name is used as a fallback.
- Use `recursive: true` only when the provider stores skills in nested trees.
- Keep the emitted `command` string aligned with the provider's real skill syntax.

Current skill discovery roots are:

| Provider | User Roots | Project / Repo Roots | Prefix | Notes |
| --- | --- | --- | --- | --- |
| Claude | `~/.claude/skills` | `<workspace>/.claude/skills` | `/` | Also discovers Claude plugin skills from enabled plugin installs. Command skills live under `commands/`; markdown skills live under `skills/` and are scanned recursively. |
| Codex | `~/.agents/skills`, `~/.codex/skills/.system`, `/etc/codex/skills` | `<workspace>/.agents/skills`, `path.dirname(workspacePath)/.agents/skills`, topmost git root `.agents/skills` | `$` | Overlapping roots are deduplicated before scanning. |
| Cursor | `~/.cursor/skills` | `<workspace>/.cursor/skills`, `<workspace>/.agents/skills` | `/` | Uses slash-style commands. |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | Cwd-to-topmost-git-root `.opencode/skills`, `.claude/skills`, and `.agents/skills` | `/` | Reuses OpenCode, Claude, and Agents skill locations. Overlapping roots are deduplicated before scanning. |

Command forms currently used by the providers are:

- Claude user/project skills: `/skill-name`
- Claude plugin skills: `/plugin-name:skill-name`
- Codex skills: `$skill-name`
- Cursor skills: `/skill-name`
- OpenCode skills: `/skill-name`

6. Implement sessions.

- Implement `normalizeMessage(raw, sessionId)` and `fetchHistory(sessionId, options)`.
- Use `createNormalizedMessage(...)` and `generateMessageId(...)` for emitted messages.
- Keep normalized message ids unique. If one raw event produces multiple text
  parts, append a discriminator so ids do not collide.
- Keep pagination consistent:
  - `limit: null` means unbounded/full history.
  - `limit: 0` means an empty page.
  - always return `total`, `hasMore`, `offset`, and `limit` when paginating.
- Sanitize any filesystem-derived ids before using them in file or database paths.
- Do not assume a provider's history format matches another provider's format.

7. Implement session synchronization.

- Implement `synchronize(since?: Date)` to scan provider artifacts and upsert
  sessions into `sessionsDb`.
- Implement `synchronizeFile(filePath)` for single-file watcher updates.
- Use the existing helpers when they fit:
  - `buildLookupMap(...)`
  - `extractFirstValidJsonlData(...)`
  - `findFilesRecursivelyCreatedAfter(...)`
  - `normalizeSessionName(...)`
  - `readFileTimestamps(...)`
- Make the sync resilient to partial, malformed, or missing provider files.
- The orchestration service runs all provider synchronizers and only advances
  `scan_state.last_scanned_at` when every provider succeeds.

Current session sync roots are:

| Provider | Scan Roots | Metadata Helpers / Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Uses `~/.claude/history.jsonl` for name lookup and the trailing `ai-title`, `last-prompt`, or `custom-title` entries for title recovery. |
| Codex | Native `thread/list` and `~/.codex/sessions/**/*.jsonl` | Follows native names, then the latest appended `session_index.jsonl` name. Only explicit Codey renames override them; index-only changes are watched independently of rollout creation time. |
| Cursor | `~/.cursor/projects/**/*.jsonl` | Uses sibling `worker.log` to recover `workspacePath`, then derives the session title from the first user prompt. |
| OpenCode | `~/.local/share/opencode/opencode.db` | Reads active sessions/messages/parts from OpenCode's shared SQLite database and stores `jsonl_path` as `null` so deleting one app session cannot remove the shared DB. |

Codex title synchronization uses `sessions.custom_name_source` to distinguish
automatic/imported titles (`auto`) from explicit local renames (`user`).
App-generated first-message titles remain automatic. Native names take priority
over an older JSONL index even when a rollout watcher runs after a native poll.
The database guards manual titles at write time, so a rename racing an index
read is not lost. Explicit local renames do not rename the underlying Codex thread.

For a newly created Codey conversation, the runtime dispatcher also starts one
best-effort background title job after persisting the native ID. It summarizes
the first user message with the thread's configured custom Responses provider
and existing credentials, then assigns an otherwise unnamed native thread
through `thread/name/set`. This is not a prompt or extra turn in the conversation.
The confirmed name is cached as `auto` and broadcast to Codey immediately.

The job uses a separate metadata-only native connection, at most 4,000 input
characters, a requested 512-token output budget, no tools, and a 30-second
deadline. At most two jobs run at once, with 32 total admitted jobs; overload,
failures and unsupported auth leave the initial local title and do not block
chat. Custom Responses providers with HTTPS or loopback HTTP are supported;
the title helper never extracts ChatGPT OAuth credentials or switches accounts.
Native/local names are rechecked before the single native write. Since that
API offers no compare-and-set, the cross-client check is not an atomic lock.
Existing conversations, imports, forks and blank/image-only first messages are
not automatically renamed or backfilled.

Before this distinction existed, title provenance was not recorded. The upgrade
retains old Codex labels in `sessions.legacy_custom_name` and treats their effective
titles as automatic; an old manual label cannot be identified reliably and can
be reapplied through Codey's rename action. The backup is not rewritten on later
starts. Claude's first-seen index behavior and other providers' app-title policy
are unchanged.

8. Register the provider.

- Add the new provider class to `server/modules/providers/provider.registry.ts`.
- Update `server/modules/providers/provider.routes.ts` provider parsing.
- If the provider introduces a new service or lifecycle hook, export it from the module entrypoint that consumes providers.

9. Wire runtime and UI surfaces outside the providers module when needed.

If the provider can run live chat sessions, update the runtime entrypoints too:

- `server/modules/providers/list/<provider>/<provider>-runtime.provider.js`
- `server/modules/providers/list/<provider>/<provider>.provider.ts`
- `server/modules/agent/agent.routes.ts`
- `server/index.ts`

If the provider is visible in the UI, update:

- provider model fallback files under `server/modules/providers/list/<provider>/`
- `src/components/chat/hooks/useChatProviderState.ts`
- `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx`
- `src/components/provider-auth/view/ProviderLoginModal.tsx`
- `src/components/mcp/constants.ts`

## Minimal Wrapper Template

```ts
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { <Provider>ProviderAuth } from './<provider>-auth.provider.js';
import { <Provider>ProviderModels } from './<provider>-models.provider.js';
import { <Provider>McpProvider } from './<provider>-mcp.provider.js';
import { <provider>Runtime } from './<provider>-runtime.provider.js';
import { <Provider>SkillsProvider } from './<provider>-skills.provider.js';
import { <Provider>SessionsProvider } from './<provider>-sessions.provider.js';
import { <Provider>SessionSynchronizer } from './<provider>-session-synchronizer.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

export class <Provider>Provider extends AbstractProvider {
  readonly runtime: IProviderRuntime = <provider>Runtime;
  readonly models: IProviderModels = new <Provider>ProviderModels();
  readonly auth: IProviderAuth = new <Provider>ProviderAuth();
  readonly mcp: IProviderMcp = new <Provider>McpProvider();
  readonly skills: IProviderSkills = new <Provider>SkillsProvider();
  readonly sessions: IProviderSessions = new <Provider>SessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer =
    new <Provider>SessionSynchronizer();

  constructor() {
    super('<provider>');
  }
}
```

## Minimal Skills Template

```ts
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class <Provider>SkillsProvider extends SkillsProvider {
  constructor() {
    super('<provider>');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.<provider>', 'skills'),
        commandPrefix: '/',
      },
    ];
  }
}
```

## Minimal Session Sync Template

```ts
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

export class <Provider>SessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    return null;
  }
}
```

## AI Prompt Template

Use this prompt when asking an AI agent to add a provider:

```text
Add a new provider "<provider>" using the current provider module architecture.

Requirements:
1) Create:
    - server/modules/providers/list/<provider>/<provider>.provider.ts
    - server/modules/providers/list/<provider>/<provider>-runtime.provider.js
   - server/modules/providers/list/<provider>/<provider>-auth.provider.ts
   - server/modules/providers/list/<provider>/<provider>-models.provider.ts
   - server/modules/providers/list/<provider>/<provider>-mcp.provider.ts
   - server/modules/providers/list/<provider>/<provider>-skills.provider.ts
   - server/modules/providers/list/<provider>/<provider>-sessions.provider.ts
   - server/modules/providers/list/<provider>/<provider>-session-synchronizer.provider.ts
2) Register in:
    - server/modules/providers/provider.registry.ts
    - server/modules/providers/provider.routes.ts
   - server/shared/types.ts LLMProvider
   - src/types/app.ts LLMProvider
3) Mirror the nearest existing provider implementation for file naming, style,
   and error handling.
4) Implement skills support with SkillsProvider and the current skill roots.
5) Implement session synchronization if the provider stores transcript files.
6) Ensure sessions use unique ids, safe path handling, and correct pagination.
7) Keep `sessions` and `sessionSynchronizer` separate.
8) Run:
   - npx eslint <touched files>
   - npx tsc --noEmit -p server/tsconfig.json
```

## Validation

After adding or changing a provider, run the relevant checks:

```bash
npx eslint server/modules/providers/**/*.ts server/shared/types.ts server/shared/interfaces.ts
npx tsc --noEmit -p server/tsconfig.json
```

Useful tests in this repo:

- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/providers/tests/skills.test.ts`
- `server/modules/providers/tests/opencode-sessions.test.ts`

If you touch sessions or session synchronization, add or update focused tests
alongside the implementation.

## Common Mistakes

- Adding provider files but forgetting `provider.registry.ts` or
  `provider.routes.ts`.
- Adding a live runtime without exposing it from the provider wrapper.
- Updating backend provider ids but not `src/types/app.ts` or the frontend
  provider constants.
- Omitting `runtime`, `skills`, or `sessionSynchronizer` from the wrapper.
- Returning duplicate normalized message ids for split content.
- Treating `limit === 0` as unbounded history.
- Building file paths from raw session ids without validation.
- Hardcoding a skill root without checking the provider's actual discovery rules.
- Forgetting that Claude plugin skills are discovered differently from normal
  user/project skill folders.
- Assuming one provider's MCP config file format works for the others.
