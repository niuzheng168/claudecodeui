// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution (same choice as the worktrees git runner).
import spawn from 'cross-spawn';

// A git still listing after this is stopped, and what it printed so far is used.
const GIT_LISTING_TIMEOUT_MS = 20_000;

type GitFileListing = { paths: string[]; truncated: boolean };

/**
 * Runs `git ls-files -z` with `args` in the project and collects the paths it
 * prints, at most `maximumFiles`. Null when git cannot run or fails, as it
 * does outside a Git work tree.
 */
function runLsFiles(projectRoot: string, args: string[], maximumFiles: number): Promise<GitFileListing | null> {
  return new Promise((resolve) => {
    // Read-only: inherited GIT_* values cannot point it at another repository,
    // and it takes no optional locks.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      GIT_OPTIONAL_LOCKS: '0',
    };
    const child = spawn('git', ['ls-files', '-z', ...args], {
      cwd: projectRoot,
      shell: false,
      env,
      timeout: GIT_LISTING_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const paths: string[] = [];
    // The start of a path whose end is in the next chunk.
    let rest: Buffer = Buffer.alloc(0);
    let truncated = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      for (let end = data.indexOf(0, start); end !== -1; end = data.indexOf(0, start)) {
        if (paths.length === maximumFiles) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        const filePath = data.toString('utf8', start, end);
        // A file with a merge conflict is printed once per stage, one after another.
        if (filePath !== paths[paths.length - 1]) paths.push(filePath);
        start = end + 1;
      }
      rest = data.subarray(start);
    });
    child.stderr?.resume();
    child.on('error', () => resolve(null));
    child.on('close', (code, signal) => {
      if (truncated || (signal && paths.length > 0)) {
        resolve({ paths, truncated: true });
        return;
      }
      resolve(code === 0 ? { paths, truncated: false } : null);
    });
  });
}

/**
 * Lists the files git shows in a project, for File Tree's file search:
 * tracked ones, including those of checked-out submodules, then untracked
 * ones it does not ignore. Paths are relative to the project root, which may
 * be a folder inside the repository. A file deleted but not yet staged as
 * deleted is still listed.
 *
 * Used by the File Tree composition root as its `FileTreeGitGateway`.
 * @returns null outside a Git work tree, or when git cannot run there
 */
export async function listGitFiles(projectRoot: string, maximumFiles: number): Promise<GitFileListing | null> {
  const [tracked, untracked] = await Promise.all([
    runLsFiles(projectRoot, ['--cached', '--recurse-submodules'], maximumFiles),
    runLsFiles(projectRoot, ['--others', '--exclude-standard'], maximumFiles),
  ]);
  if (!tracked) return null;
  const paths = untracked ? tracked.paths.concat(untracked.paths) : tracked.paths;
  return {
    paths: paths.length > maximumFiles ? paths.slice(0, maximumFiles) : paths,
    truncated: tracked.truncated || Boolean(untracked?.truncated) || paths.length > maximumFiles,
  };
}
