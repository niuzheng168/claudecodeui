// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// Strict Codey SSO: used by the HTTP entrypoint and WebSocket handshake verifier.
export { portalSsoMiddleware, authenticatePortalWebSocket } from './portal-sso.module.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';
