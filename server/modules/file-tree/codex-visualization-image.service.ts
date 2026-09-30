import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isPathInsideDirectory } from '@/shared/index.js';
import type { FileTreeTranscriptImageGateway } from '@/shared/index.js';

type CodexVisualizationDependencies = {
  resolveHomeDirectory(): string;
  findSession(nativeSessionId: string): {
    provider: string;
    nativeSessionId: string | null;
    projectPath: string | null;
  } | null;
};

const NATIVE_SESSION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function rasterContentType(header: Buffer): string | null {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (header.length >= 12
    && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * File Tree composition and tests use this narrow Codex artifact reader.
 * Only raster images in CODEX_HOME/visualizations/YYYY/MM/DD/<native-thread>/
 * belonging to the selected project are readable. It neither trusts a path's
 * thread id alone nor grants access to all of CODEX_HOME or other sessions.
 */
export function createCodexVisualizationImageService(
  dependencies: CodexVisualizationDependencies,
): FileTreeTranscriptImageGateway {
  return {
    async openImage(projectPath, filePath) {
      // Never turn relative traversal, file URLs, ADS or arbitrary absolute
      // paths into filesystem probes outside the selected project's scope.
      if (!path.isAbsolute(filePath) || /[\u0000-\u001f\u007f]/.test(filePath)
        || filePath.split(/[\\/]/).includes('..')) return null;
      const home = path.resolve(dependencies.resolveHomeDirectory());
      const requestedPath = path.resolve(filePath);
      const visualizationRoot = path.join(home, 'visualizations');
      if (!isPathInsideDirectory(visualizationRoot, requestedPath)) return null;

      const parts = path.relative(visualizationRoot, requestedPath).split(path.sep);
      const [year, month, day, threadId, ...fileParts] = parts;
      if (parts.length < 5 || !/^\d{4}$/.test(year)
        || !/^(0[1-9]|1[0-2])$/.test(month) || !/^(0[1-9]|[12]\d|3[01])$/.test(day)
        || !NATIVE_SESSION_ID.test(threadId)
        || fileParts.some((part) => !part || /[:\\]/.test(part))
        || !IMAGE_EXTENSIONS.has(path.extname(requestedPath).toLowerCase())) return null;

      const session = dependencies.findSession(threadId.toLowerCase());
      if (session?.provider !== 'codex' || session.nativeSessionId?.toLowerCase() !== threadId.toLowerCase()
        || !session.projectPath || !path.isAbsolute(session.projectPath)
        || path.relative(path.resolve(projectPath), path.resolve(session.projectPath)) !== '') return null;

      // The Codex home itself may be symlinked (e.g. /var -> /private/var on
      // macOS), but a visualization/date/thread symlink must not change the
      // authorized session boundary. Nested links may only stay inside it.
      const canonicalHome = await realpath(home);
      const sessionRoot = path.join(canonicalHome, 'visualizations', year, month, day, threadId);
      const canonicalFile = await realpath(requestedPath);
      if (!isPathInsideDirectory(sessionRoot, canonicalFile)) return null;
      if (!(await stat(canonicalFile)).isFile()) return null;

      // Sniff and stream the same descriptor, starting at byte zero. Do not
      // trust ".png": desktop screenshots can actually contain JPEG bytes.
      // O_NONBLOCK also prevents a substituted FIFO from hanging the request.
      const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NONBLOCK);
      let streaming = false;
      try {
        if (!(await handle.stat()).isFile()) return null;
        const header = Buffer.alloc(12);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const contentType = rasterContentType(header.subarray(0, bytesRead));
        if (!contentType) return null;
        const stream = handle.createReadStream({ start: 0, autoClose: true });
        streaming = true;
        return { contentType, stream };
      } finally {
        if (!streaming) await handle.close();
      }
    },
  };
}
