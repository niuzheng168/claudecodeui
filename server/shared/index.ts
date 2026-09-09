// Auth uses the deployment flag; WebSocket uses the shared authenticated request contract.
export { IS_PLATFORM } from './utils.js';
export type { AuthenticatedWebSocketRequest } from './types.js';
// Projects tests consume the shared path-validation and error contracts through this barrel.
export { AppError, normalizeProjectPath, validateWorkspacePath } from './utils.js';
// Queued delivery uses exact persistence receipts and safe JSON parsing across module boundaries.
export type { QueuedSessionMessageRecord } from './types.js';
export { readObjectRecord } from './utils.js';
// Codex provider transports/runtime share the RPC, message and attachment contracts.
export type { ICodexRpcClient, IProviderRuntime } from './interfaces.js';
export type {
  AnyRecord, CodexRpcRequestId, CodexRpcServerReply, ProviderRuntimeContext,
  ProviderRuntimeWriter, ProviderPermissionDecision, ProviderRuntimePermissionGateway,
  LLMProvider,
} from './types.js';
export {
  createCompleteMessage, createNormalizedMessage, resolveCodexHomeDirectory,
} from './utils.js';
export { appendFilesInputTag, buildCodexInputItems } from './image-attachments.js';
