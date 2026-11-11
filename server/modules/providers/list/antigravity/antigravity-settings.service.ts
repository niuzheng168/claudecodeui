import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readObjectRecord, readOptionalString } from '@/shared/index.js';

/** Runtime, auth and session adapters share a private, persistent SDK home. */
export function antigravityHome(): string {
  return path.resolve(process.env.CODEY_ANTIGRAVITY_HOME
    || path.join(os.homedir(), '.local', 'share', 'codey-antigravity'));
}

/** The runtime/auth adapters use the same Python environment installed by Codey. */
export function antigravityPython(): string {
  return process.env.CODEY_ANTIGRAVITY_PYTHON || path.join(
    antigravityHome(), 'venv-0.1.23', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
}

/** The runtime/auth adapters locate the packaged bridge in source and compiled builds. */
export function antigravityBridge(): string {
  for (const relative of [
    '../../../../../shared/antigravity/bridge.py',
    '../../../../../../shared/antigravity/bridge.py',
  ]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(file)) return file;
  }
  throw new Error('The Codey package is missing shared/antigravity/bridge.py.');
}

/** Auth and runtime read only node-local configuration, never client-supplied credentials. */
export function readAntigravityCredentials() {
  const file = process.env.CODEY_ANTIGRAVITY_CONFIG
    || path.join(os.homedir(), '.config', 'codey', 'antigravity.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = readObjectRecord(JSON.parse(readFileSync(file, 'utf8'))) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Cannot read Antigravity settings. Check the node-local JSON configuration.');
    }
  }
  const vertex = settings.vertex === true || /^(true|1)$/i.test(process.env.GOOGLE_GENAI_USE_VERTEXAI || '');
  const apiKey = readOptionalString(process.env.GEMINI_API_KEY) ?? readOptionalString(settings.apiKey);
  const baseUrl = readOptionalString(process.env.CODEY_ANTIGRAVITY_BASE_URL) ?? readOptionalString(settings.baseUrl);
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Antigravity baseUrl must be an HTTP(S) URL without embedded credentials.');
    }
  }
  return {
    vertex, apiKey, baseUrl,
    project: readOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ?? readOptionalString(settings.project),
    location: readOptionalString(process.env.GOOGLE_CLOUD_LOCATION) ?? readOptionalString(settings.location),
  };
}
