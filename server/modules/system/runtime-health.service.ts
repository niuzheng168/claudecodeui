import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type CodeyRuntime = {
  name: 'codey';
  version: string;
  commit: string;
  releaseId: string;
  nodeMajor: number;
};

type RuntimeHealthDependencies = {
  read?: (filename: string) => string;
  nodeVersion?: string;
};

function version(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80
    && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(value);
}

/**
 * Used by the server bootstrap for public HTTPS /health metadata. Capture once:
 * replacing package files must not relabel an already-running process.
 * Only an actual Codey package with matching committed build metadata receives
 * a Codey identity; managed standalone CloudCLI remains a component version.
 * No configuration, credentials, paths, subprocesses or network access.
 */
export function readRunningPackage(
  appRoot: string,
  { read = (filename) => fs.readFileSync(filename, 'utf8'), nodeVersion = process.versions.node }: RuntimeHealthDependencies = {},
) {
  let runningVersion: string | null = null;
  let codey: Readonly<CodeyRuntime> | null = null;
  try {
    const packageText = read(path.join(appRoot, 'package.json'));
    if (packageText.length > 64 * 1024) return Object.freeze({ version: null, codey: null });
    const pkg = JSON.parse(packageText);
    runningVersion = version(pkg?.version) ? pkg.version : null;
    if (pkg?.name === 'codey' && runningVersion) {
      const buildText = read(path.join(appRoot, 'codey-build.json'));
      if (buildText.length > 64 * 1024) return Object.freeze({ version: runningVersion, codey: null });
      const build = JSON.parse(buildText);
      const nodeMajor = Number(nodeVersion.split('.')[0]);
      if (build?.schema === 1 && build.name === 'codey' && build.version === runningVersion
          && build.sourceDirty === false && /^[a-f0-9]{40}$/.test(build.sourceCommit ?? '')
          && Number.isSafeInteger(nodeMajor) && nodeMajor > 0 && nodeMajor < 1000) {
        codey = Object.freeze({
          name: 'codey', version: runningVersion, commit: build.sourceCommit,
          releaseId: 'machine-' + createHash('sha256').update(buildText).digest('hex').slice(0, 16),
          nodeMajor,
        });
      }
    }
  } catch {
    // A missing/malformed identity is unknown, never an inferred Codey release.
  }
  return Object.freeze({ version: runningVersion, codey });
}
