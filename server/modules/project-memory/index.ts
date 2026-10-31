// The node HTTP entrypoint mounts the owner-only main-node memory API.
export { createProjectMemoryRoutes } from './project-memory.routes.js';
// The node entrypoint owns the lifetime of source hooks and main jobs.
export { initializeProjectMemory, closeProjectMemory } from './services/project-memory-runtime.service.js';
