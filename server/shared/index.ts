// Auth uses the deployment flag; WebSocket uses the shared authenticated request contract.
export { IS_PLATFORM } from './utils.js';
export type { AuthenticatedWebSocketRequest } from './types.js';
// Projects tests consume the shared path-validation and error contracts through this barrel.
export { AppError, normalizeProjectPath, validateWorkspacePath } from './utils.js';
// Queued delivery uses exact persistence receipts and safe JSON parsing across module boundaries.
export type { QueuedSessionMessageRecord } from './types.js';
export { readObjectRecord } from './utils.js';
