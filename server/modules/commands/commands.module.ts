import * as fs from 'node:fs/promises';
import os from 'node:os';

import express from 'express';

import { codexCommandsService, providerModelsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/index.js';

import { createCommandsRouter } from './commands.routes.js';
import { createNativeCommandsRouter } from './native-commands.routes.js';

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = express.Router();
commandsRoutes.use(createNativeCommandsRouter(codexCommandsService.goal));
commandsRoutes.use(createCommandsRouter({
  fileSystem: fs,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
}));
