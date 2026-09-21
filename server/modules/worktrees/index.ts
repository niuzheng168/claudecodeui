// worktreesRoutes: used by the server entrypoint to mount the complete Worktrees HTTP API at `/api/worktrees`.
export { worktreesRoutes } from './worktrees.module.js';
// File Tree uses the read-only, repository-verified boundary for linked files.
export { resolveRelatedWorktreeRoot } from './worktrees.module.js';
