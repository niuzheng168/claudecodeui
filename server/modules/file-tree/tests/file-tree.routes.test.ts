import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { AppError } from '@/shared/index.js';
import type { FileTreeServices } from '@/shared/index.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('text, raw-content and save routes forward absolute worktree file paths unchanged', async () => {
  const filePath = '/workspace/linked worktree/设计.md';
  const calls: unknown[][] = [];
  const services = createFakeServices({
    readTextFile: async (...input) => {
      calls.push(['read', ...input]);
      return { content: '# design', path: filePath };
    },
    openFile: async (...input) => {
      calls.push(['open', ...input]);
      return { contentType: 'text/markdown', stream: Readable.from(['# design']) };
    },
    saveTextFile: async (...input) => {
      calls.push(['save', ...input]);
      return { success: true, path: filePath, message: 'File saved successfully' };
    },
  });
  await withFileTreeServer(services, async (baseUrl) => {
    const endpoint = `${baseUrl}/api/file-tree/projects/main-project`;
    const text = await fetch(`${endpoint}/file?${new URLSearchParams({ filePath })}`);
    assert.equal(text.status, 200);
    assert.deepEqual(await text.json(), { content: '# design', path: filePath });
    const raw = await fetch(`${endpoint}/files/content?${new URLSearchParams({ path: filePath })}`);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), '# design');
    const saved = await fetch(`${endpoint}/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath, content: '# updated' }),
    });
    assert.equal(saved.status, 200);
    await saved.json();
  });
  assert.deepEqual(calls, [
    ['read', 'main-project', filePath],
    ['open', 'main-project', filePath],
    ['save', 'main-project', filePath, '# updated'],
  ]);
});

test('file routes preserve a concrete scope rejection for the editor', async () => {
  const error = 'Path must be under the project root or a related Git worktree';
  const denied = async (): Promise<never> => {
    throw new AppError(error, { statusCode: 403, code: 'PATH_OUTSIDE_PROJECT' });
  };
  await withFileTreeServer(createFakeServices({
    readTextFile: denied, openFile: denied, saveTextFile: denied,
  }), async (baseUrl) => {
    const endpoint = `${baseUrl}/api/file-tree/projects/main-project`;
    for (const [url, init] of [
      [`${endpoint}/file?filePath=/unrelated/doc.md`, {}],
      [`${endpoint}/files/content?path=/unrelated/doc.md`, {}],
      [`${endpoint}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath: '/unrelated/doc.md', content: 'no' }),
      }],
    ] as const) {
      const response = await fetch(url, init);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error });
    }
  });
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});
