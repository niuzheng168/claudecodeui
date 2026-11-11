// Auth uses the deployment flag; WebSocket uses the shared authenticated request contract.
export { IS_PLATFORM } from './utils.js';
export type { AuthenticatedWebSocketRequest } from './types.js';
// Azure DevOps routes and their reader share a credential-free, validated target.
export type { AzureDevOpsTarget } from './types.js';
// Project-memory storage, source pagination and main workers share content-bound checkpoints.
export type { MemoryCheckpoint, ProjectMemoryJob } from './types.js';
export { redactProjectMemoryText } from './utils.js';
// Projects, Providers and Settings consume shared validation/error contracts through this barrel.
export { AppError, normalizeProjectPath, validateWorkspacePath } from './utils.js';
// Queued delivery uses exact persistence receipts and safe JSON parsing across module boundaries.
export type { QueuedMessageOperation, QueuedSessionMessageRecord } from './types.js';
export { readObjectRecord } from './utils.js';
// Providers' managed model API adapter uses the shared catalog contracts.
export type { ProviderModelOption, ProviderModelsDefinition } from './types.js';
// WebSocket acceptance assigns one persisted input identity per native submission.
export { generateMessageId } from './utils.js';
// Codex provider transports/runtime share the RPC, message and attachment contracts.
export type { ICodexRpcClient, ICodexDesktopThreadOwner, IProvider, IProviderRuntime } from './interfaces.js';
export type {
  AnyRecord, CodexRpcRequestId, CodexRpcServerReply, CodexDesktopThreadState, ProviderRuntimeContext,
  ProviderRuntimeWriter, ProviderPermissionDecision, ProviderRuntimePermissionGateway,
  NewSessionTitleRequest, ProviderRunFunction,
  LLMProvider, NativeTranscriptPosition, ProviderAbortOptions, ProviderRuntimeObservation,
  ProviderSteerReceipt, CodexGoal, CodexGoalCommand, CodexGoalCommandResult,
} from './types.js';
export {
  createCompleteMessage, createNormalizedMessage, resolveCodexHomeDirectory,
} from './utils.js';
// Codex and Claude automatic session titles share one prompt, output schema and validator.
export {
  SESSION_TITLE_INSTRUCTIONS, SESSION_TITLE_SCHEMA, parseSessionTitle, readBoundedJsonResponse,
} from './utils.js';
// The Codex title generator and Activity's session summaries read Responses API answers alike.
export { readResponsesOutputText } from './utils.js';
// Project-memory routes use the shared async Express error adapter.
export { asyncHandler } from './utils.js';
// Activity writes one-line session summaries for the Codey Portal: prompt, schema, validator and fallback.
export {
  SESSION_SUMMARY_INSTRUCTIONS, SESSION_SUMMARY_SCHEMA, fallbackSessionSummary, parseSessionSummary,
} from './utils.js';
export type { SessionSummary, SessionSummaryRequest } from './types.js';
export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
// Commands resolves application metadata and parses local custom command frontmatter.
export { findApplicationRoot, getModuleDirectory } from './utils.js';
export { parseFrontMatter } from './frontmatter.js';
// Providers use the shared session/history contracts and projections through this barrel.
export type { IProviderSessions, IProviderSessionSynchronizer, IProviderFork } from './interfaces.js';
export type {
  BackgroundTaskSummary, CodexHistoryPageRequest, FetchHistoryOptions, FetchHistoryResult, MemoryCitation,
  NormalizedMessage, ScheduledTaskSummary, SubagentActivity, SubagentInfo, WorkflowAgentActivity,
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
  FORBIDDEN_WORKSPACE_PATHS, WORKSPACES_ROOT, isPathInsideDirectory, resolveReadOnlyRootPath,
} from './utils.js';
export type {
  FileTreeDirectoryEntry, FileTreeFileSystem, FileTreeGitGateway, FileTreeLogger, FileTreeNode,
  FileTreeProjectGateway, FileTreeServiceDependencies, FileTreeServices, FileTreeTranscriptImageGateway,
  FileTreeStats, FileTreeUploadedFile, FileTreeWorkspaceGateway, FileTreeWorktreeGateway,
  GitCommandResult, GitCommandRunner, WorkspacePathValidationResult, WorktreeFileSystem, WorktreePorcelainEntry,
  WorktreeProjectGateway, WorktreeServices,
} from './types.js';

// Providers' read-only side questions and File Tree scope checks use these shared contracts.
export type { SideQuestionOutcome, SideQuestionRequest, SideQuestionSink } from './types.js';
export {
  resolvePathUnderRoots, SIDE_CONVERSATION_BOUNDARY_PROMPT,
  SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS, SIDE_QUESTION_ANSWER_SEPARATOR,
} from './utils.js';

// Claude's runtime uses the same shared CLI, content and error boundaries as the other adapters.
export { buildClaudeUserContent } from './image-attachments.js';
// Antigravity validates uploaded/workspace attachments before giving paths to the SDK.
export { normalizeAttachmentDescriptors, resolveImageAbsolutePath, isAllowedImageSourcePath } from './image-attachments.js';
export { resolveClaudeCodeExecutablePath } from './claude-cli-path.js';
export { errorMessage } from './utils.js';
// Provider auth adapters report the configured CLI's version through the shared probe contract.
export type { IProviderAuth } from './interfaces.js';
export type { CliVersionProbe, ProviderAuthStatus } from './types.js';
export { probeCliVersion, readOptionalString } from './utils.js';
// Antigravity's SDK facets use the existing shared model, MCP and skills contracts.
export type { IProviderModels } from './interfaces.js';
export type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput, ProviderSkillSource } from './types.js';
export { readJsonConfig, writeJsonConfig, readStringArray, readStringRecord } from './utils.js';
export { readCodeyModelApiConfiguration } from './utils.js';
