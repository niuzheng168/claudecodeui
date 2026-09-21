// Auth uses the deployment flag; WebSocket uses the shared authenticated request contract.
export { IS_PLATFORM } from './utils.js';
export type { AuthenticatedWebSocketRequest } from './types.js';
// Projects tests consume the shared path-validation and error contracts through this barrel.
export { AppError, normalizeProjectPath, validateWorkspacePath } from './utils.js';
// Queued delivery uses exact persistence receipts and safe JSON parsing across module boundaries.
export type { QueuedSessionMessageRecord } from './types.js';
export { readObjectRecord } from './utils.js';
// WebSocket acceptance assigns one persisted input identity per native submission.
export { generateMessageId } from './utils.js';
// Codex provider transports/runtime share the RPC, message and attachment contracts.
export type { ICodexRpcClient, ICodexDesktopThreadOwner, IProvider, IProviderRuntime } from './interfaces.js';
export type {
  AnyRecord, CodexRpcRequestId, CodexRpcServerReply, CodexDesktopThreadState, ProviderRuntimeContext,
  ProviderRuntimeWriter, ProviderPermissionDecision, ProviderRuntimePermissionGateway,
  NewCodexSessionTitleRequest, ProviderRunFunction,
  LLMProvider, NativeTranscriptPosition, ProviderAbortOptions, ProviderRuntimeObservation,
  CodexGoal, CodexGoalCommand, CodexGoalCommandResult,
} from './types.js';
export {
  createCompleteMessage, createNormalizedMessage, resolveCodexHomeDirectory,
} from './utils.js';
export { appendFilesInputTag, buildCodexInputItems } from './image-attachments.js';
// Commands resolves application metadata and parses local custom command frontmatter.
export { findApplicationRoot, getModuleDirectory } from './utils.js';
export { parseFrontMatter } from './frontmatter.js';
// Providers use the shared session/history contracts and projections through this barrel.
export type { IProviderSessions, IProviderSessionSynchronizer, IProviderFork } from './interfaces.js';
export type {
  FetchHistoryOptions, FetchHistoryResult, MemoryCitation, NormalizedMessage,
  SubagentActivity, SubagentInfo,
} from './types.js';
export {
  buildLookupMap, extractFirstValidJsonlData, findFilesRecursivelyCreatedAfter,
  normalizeSessionName, readFileTimestamps, sliceTailPage,
  truncateSubagentActivity,
} from './utils.js';
export { parseFilesInputTag, toImageAttachments } from './image-attachments.js';
export { prepareTranscriptMessages } from './message-unification.js';
// File Tree and Worktrees share filesystem scope checks and injected capabilities.
export {
  FORBIDDEN_WORKSPACE_PATHS, WORKSPACES_ROOT, isPathInsideDirectory,
} from './utils.js';
export type {
  FileTreeDirectoryEntry, FileTreeFileSystem, FileTreeLogger, FileTreeNode,
  FileTreeProjectGateway, FileTreeServiceDependencies, FileTreeServices,
  FileTreeStats, FileTreeUploadedFile, FileTreeWorkspaceGateway, FileTreeWorktreeGateway,
  GitCommandResult, GitCommandRunner, WorktreeFileSystem, WorktreePorcelainEntry,
  WorktreeProjectGateway, WorktreeServices,
} from './types.js';
