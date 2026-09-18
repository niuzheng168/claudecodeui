// createSystemModule: used by the server entrypoint to mount protected system update routes.
export { createSystemModule } from './system.module.js';
// readRunningPackage: captures safe package identity for the server's public health route.
export { readRunningPackage } from './runtime-health.service.js';
