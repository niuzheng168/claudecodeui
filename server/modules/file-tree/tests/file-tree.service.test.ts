import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeStats,
} from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    worktrees: {
      resolveRoot: async () => null,
    },
    workspace: {
      rootPath: path.dirname(projectRoot),
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('ordinary project files need no Git lookup and use their canonical path', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const requestedPath = path.join(projectRoot, 'linked.txt');
  const canonicalPath = path.join(projectRoot, 'notes.txt');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => candidate === requestedPath ? canonicalPath : candidate,
    readTextFile: async (candidate) => {
      assert.equal(candidate, canonicalPath);
      return 'project notes';
    },
  });
  const dependencies = createDependencies(fileSystem, projectRoot);
  dependencies.worktrees.resolveRoot = async () => {
    throw new Error('In-project reads must not query Git');
  };

  assert.deepEqual(
    await createFileTreeService(dependencies).readTextFile('project-1', 'linked.txt'),
    { content: 'project notes', path: requestedPath },
  );
});

test('related worktree text, media and saves share the verified file boundary', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const worktreeRoot = path.resolve('file-tree-test-worktree');
  const targetPath = path.join(worktreeRoot, 'docs', 'design.md');
  const writes: Array<[string, string]> = [];
  const scopes: Array<[string, string]> = [];
  const validations: string[] = [];
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => candidate,
    access: async (candidate) => { assert.equal(candidate, targetPath); },
    readTextFile: async (candidate) => {
      assert.equal(candidate, targetPath);
      return '# worktree design';
    },
    writeTextFile: async (candidate, content) => { writes.push([candidate, content]); },
    createReadStream: (candidate) => {
      assert.equal(candidate, targetPath);
      return Readable.from(['# worktree design']);
    },
  });
  const dependencies = createDependencies(fileSystem, projectRoot);
  dependencies.worktrees.resolveRoot = async (...input) => {
    scopes.push(input);
    return worktreeRoot;
  };
  dependencies.workspace.validatePath = async (candidate) => {
    validations.push(candidate);
    return { valid: true, resolvedPath: candidate };
  };
  const service = createFileTreeService(dependencies);

  assert.deepEqual(await service.readTextFile('project-1', targetPath), {
    content: '# worktree design', path: targetPath,
  });
  const opened = await service.openFile('project-1', targetPath);
  assert.equal(opened.contentType, 'text/plain');
  let streamed = '';
  for await (const chunk of opened.stream) streamed += chunk;
  assert.equal(streamed, '# worktree design');
  assert.equal((await service.saveTextFile('project-1', targetPath, '# updated')).success, true);
  assert.deepEqual(writes, [[targetPath, '# updated']]);
  assert.deepEqual(scopes, Array.from({ length: 3 }, () => [projectRoot, targetPath]));
  assert.deepEqual(validations, Array.from({ length: 3 }, () => worktreeRoot));
});

test('unrelated and prefix-matching sibling paths remain forbidden before filesystem access', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const service = createFileTreeService(createDependencies(createFakeFileSystem(), projectRoot));
  for (const filePath of [
    path.join(`${projectRoot}-other`, 'secret.txt'),
    path.resolve('unrelated', 'secret.txt'),
    path.join(path.dirname(projectRoot), '.ssh', 'id_ed25519'),
    projectRoot,
  ]) {
    await assert.rejects(service.readTextFile('project-1', filePath), {
      code: 'PATH_OUTSIDE_PROJECT', statusCode: 403,
    });
    await assert.rejects(service.openFile('project-1', filePath), { statusCode: 403 });
    await assert.rejects(service.saveTextFile('project-1', filePath, 'no'), { statusCode: 403 });
  }
});

test('relative traversal never invokes related-worktree discovery', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const dependencies = createDependencies(createFakeFileSystem(), projectRoot);
  dependencies.worktrees.resolveRoot = async () => { throw new Error('must not run'); };
  const service = createFileTreeService(dependencies);
  for (const relativePath of ['../worktree/doc.md', 'docs/../../worktree/doc.md']) {
    await assert.rejects(service.readTextFile('project-1', relativePath), { statusCode: 403 });
    await assert.rejects(service.openFile('project-1', relativePath), { statusCode: 403 });
    await assert.rejects(service.saveTextFile('project-1', relativePath, 'no'), { statusCode: 403 });
  }
});

test('related worktrees cannot bypass the configured workspace boundary', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const worktreeRoot = path.resolve('outside-workspace');
  const dependencies = createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate,
  }), projectRoot);
  dependencies.worktrees.resolveRoot = async () => worktreeRoot;
  dependencies.workspace.validatePath = async () => ({ valid: false, error: 'Outside workspace policy' });
  const service = createFileTreeService(dependencies);
  await assert.rejects(service.readTextFile('project-1', path.join(worktreeRoot, 'design.md')), {
    code: 'INVALID_WORKSPACE_PATH', statusCode: 403, message: 'Outside workspace policy',
  });
});

test('workspace policy checks the exact canonical root, not a normalized sibling prefix', async () => {
  const workspaceRoot = path.resolve('allowed-workspace');
  const projectRoot = path.join(workspaceRoot, 'project');
  const worktreeRoot = `${workspaceRoot} `;
  const dependencies = createDependencies(createFakeFileSystem({
    realpath: async (candidate) => candidate,
  }), projectRoot);
  dependencies.worktrees.resolveRoot = async () => worktreeRoot;
  // Simulate a user-input validator that trims whitespace before comparison.
  dependencies.workspace.validatePath = async () => ({ valid: true, resolvedPath: workspaceRoot });
  const service = createFileTreeService(dependencies);
  await assert.rejects(service.readTextFile('project-1', path.join(worktreeRoot, 'design.md')), {
    code: 'INVALID_WORKSPACE_PATH', statusCode: 403,
  });
});

test('project and worktree symlinks cannot escape the selected root for reads or writes', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const worktreeRoot = path.resolve('file-tree-test-worktree');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => candidate.endsWith('escape.txt')
      ? path.resolve('secrets', 'private.txt')
      : candidate,
  });
  const dependencies = createDependencies(fileSystem, projectRoot);
  dependencies.worktrees.resolveRoot = async () => worktreeRoot;
  const service = createFileTreeService(dependencies);
  for (const root of [projectRoot, worktreeRoot]) {
    const target = path.join(root, 'escape.txt');
    await assert.rejects(service.readTextFile('project-1', target), { statusCode: 403 });
    await assert.rejects(service.openFile('project-1', target), { statusCode: 403 });
    await assert.rejects(service.saveTextFile('project-1', target, 'no'), { statusCode: 403 });
  }
});

test('a symlinked project root still permits files under its canonical root', async () => {
  const projectRoot = path.resolve('file-tree-test-link');
  const canonicalRoot = path.resolve('file-tree-test-real');
  const targetPath = path.join(projectRoot, 'doc.md');
  const canonicalPath = path.join(canonicalRoot, 'doc.md');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => candidate === projectRoot ? canonicalRoot : canonicalPath,
    readTextFile: async (candidate) => {
      assert.equal(candidate, canonicalPath);
      return 'safe';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  assert.deepEqual(await service.readTextFile('project-1', targetPath), {
    content: 'safe', path: targetPath,
  });
});

test('missing files and permission failures retain their HTTP diagnostics', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  for (const [code, statusCode, message] of [
    ['ENOENT', 404, 'File not found'],
    ['EACCES', 403, 'Permission denied'],
    ['EPERM', 403, 'Permission denied'],
  ] as const) {
    const fileSystem = createFakeFileSystem({
      realpath: async (candidate) => {
        if (candidate === projectRoot) return candidate;
        throw Object.assign(new Error('filesystem error'), { code });
      },
    });
    const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
    await assert.rejects(service.readTextFile('project-1', 'doc.md'), { statusCode, message });
    await assert.rejects(service.openFile('project-1', 'doc.md'), { statusCode, message });
  }
});

test('saving a missing file checks its parent and rejects dangling symlinks', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const target = path.join(projectRoot, 'new.md');
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const writes: string[] = [];
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => {
      if (candidate === target) throw missing();
      return candidate;
    },
    lstat: async () => { throw missing(); },
    writeTextFile: async (candidate) => { writes.push(candidate); },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  await service.saveTextFile('project-1', target, 'new document');
  assert.deepEqual(writes, [target]);

  fileSystem.lstat = async () => ({ ...createStats(false, 0o644), isSymbolicLink: () => true });
  await assert.rejects(service.saveTextFile('project-1', target, 'no'), {
    statusCode: 403, message: 'Cannot save through an unresolved symlink',
  });
  assert.deepEqual(writes, [target]);
});

test('saving a missing file rejects a parent symlink outside the allowed root', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const linkedParent = path.join(projectRoot, 'linked-directory');
  const target = path.join(linkedParent, 'new.md');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidate) => {
      if (candidate === target) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return candidate === linkedParent ? path.resolve('secrets') : candidate;
    },
    lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  await assert.rejects(service.saveTextFile('project-1', target, 'no'), { statusCode: 403 });
});

test('worktree file access does not expand create, rename, delete or upload scope', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const worktreeRoot = path.resolve('file-tree-test-worktree');
  const dependencies = createDependencies(createFakeFileSystem(), projectRoot);
  dependencies.worktrees.resolveRoot = async () => { throw new Error('must not run'); };
  const service = createFileTreeService(dependencies);
  await assert.rejects(service.createEntry({
    projectId: 'project-1', parentPath: worktreeRoot, type: 'file', name: 'new.md',
  }), { statusCode: 403 });
  await assert.rejects(service.renameEntry({
    projectId: 'project-1', oldPath: path.join(worktreeRoot, 'doc.md'), newName: 'renamed.md',
  }), { statusCode: 403 });
  await assert.rejects(service.deleteEntry({
    projectId: 'project-1', targetPath: path.join(worktreeRoot, 'doc.md'),
  }), { statusCode: 403 });
  await assert.rejects(service.storeUploadedFiles({
    projectId: 'project-1', targetPath: worktreeRoot, relativePaths: [], requestedFileCount: 1,
    files: [{ temporaryPath: 'fixture-upload', originalName: 'doc.md', size: 1, mimeType: 'text/plain' }],
  }), { statusCode: 403 });
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});
