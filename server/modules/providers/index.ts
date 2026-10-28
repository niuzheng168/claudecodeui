export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';
// Commands uses the provider-owned native goal control path and session mapping.
export { codexCommandsService } from './services/codex-commands.service.js';
// Commands lists Claude Code's own slash commands for Claude chats.
export { claudeNativeCommandsService } from './list/claude/claude-commands.provider.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read, by
// Projects to keep a permanent delete away from native Codex history, and by
// Activity to report the busy sessions to the Codey Portal.
export { sessionsService } from './services/sessions.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// Session messages: the default permission mode of a turn they start, and the
// Claude Desktop or terminal process that holds a Claude session open.
export { providerCapabilitiesService } from './services/provider-capabilities.service.js';
export {
  findForeignSessionProcess,
  readLastPermissionMode,
} from './list/claude/claude-session-owner.service.js';
// applyClaudeArchiveChanges: used by Session messages' `/api/codey/v1` for an
// archive Claude Desktop made on another of the owner's machines.
export { applyClaudeArchiveChanges } from './list/claude/claude-desktop-archive.service.js';
