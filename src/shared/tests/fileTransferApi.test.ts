import { afterEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';

type DeploymentWindow = Window & { __CLOUDCLI_BASE_PATH__?: string };

afterEach(() => {
  delete (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__;
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('standalone file uploads retain root routing and encode the project ID', () => {
  vi.stubEnv('BASE_URL', '/');

  expect(api.uploadFilesUrl('project/with spaces')).toBe(
    '/api/file-tree/projects/project%2Fwith%20spaces/files/upload',
  );
});

test.each(['node-a', 'node-b'])('file-tree XHR uploads stay on %s rather than the Portal or shared asset root', (node) => {
  vi.stubEnv('BASE_URL', '/cloudcli-ui/ui-shared/');
  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = `/cloudcli/${node}/`;

  expect(api.uploadFilesUrl('project-id')).toBe(
    `/cloudcli/${node}/api/file-tree/projects/project-id/files/upload`,
  );
});

test('upload URLs resolve the current node at call time', () => {
  vi.stubEnv('BASE_URL', '/cloudcli-ui/ui-shared/');
  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = '/cloudcli/first-node/';
  expect(api.uploadFilesUrl('project-id')).toBe(
    '/cloudcli/first-node/api/file-tree/projects/project-id/files/upload',
  );

  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = '/cloudcli/second-node/';
  expect(api.uploadFilesUrl('project-id')).toBe(
    '/cloudcli/second-node/api/file-tree/projects/project-id/files/upload',
  );
});

test.each(['node-a', 'node-b'])('chat attachments and binary downloads use the same %s API scope', async (node) => {
  vi.stubEnv('BASE_URL', '/cloudcli-ui/ui-shared/');
  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = `/cloudcli/${node}/`;
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const form = new FormData();
  form.append('files', new File(['file bytes'], 'probe.txt', { type: 'text/plain' }));

  await api.assets.uploadFiles(form);
  await api.assets.file('stored file.txt');
  await api.assets.image('preview.png');
  await api.readFileBlob('project-id', 'nested/probe.bin');

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `/cloudcli/${node}/api/assets/files`,
    `/cloudcli/${node}/api/assets/files/stored%20file.txt`,
    `/cloudcli/${node}/api/assets/images/preview.png`,
    `/cloudcli/${node}/api/file-tree/projects/project-id/files/content?path=nested%2Fprobe.bin`,
  ]);
  const uploadOptions = fetchMock.mock.calls[0]?.[1];
  expect(uploadOptions.method).toBe('POST');
  expect(uploadOptions.body).toBe(form);
  expect(uploadOptions.headers).not.toHaveProperty('Content-Type');
});

test('all file-root operations can target a different node without changing the chat deployment', async () => {
  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = '/cloudcli/chat-node/';
  const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  const options = { apiBasePath: '/cloudcli/files-node/' };
  await api.resolveFileProject('/repo', options);
  await api.listDirectory('p1', null, options);
  await api.getFiles('p1', options);
  await api.searchFiles('p1', { query: 'hello', limit: 100, refresh: true }, options);
  await api.readFile('p1', '/repo/a', options);
  await api.readFileBlob('p1', '/repo/a', options);
  await api.saveFile('p1', '/repo/a', 'updated', options);
  await api.createFile('p1', { path: '', name: 'new', type: 'file' }, options);
  await api.renameFile('p1', { oldPath: '/repo/a', newName: 'b' }, options);
  await api.deleteFile('p1', { path: '/repo/a', type: 'file' }, options);
  expect(fetchMock).toHaveBeenCalledTimes(10);
  for (const [url, request] of fetchMock.mock.calls) {
    expect(url).toMatch(/^\/cloudcli\/files-node\/api\//);
    expect(request).not.toHaveProperty('apiBasePath');
  }
  expect(api.uploadFilesUrl('p1', options.apiBasePath)).toBe('/cloudcli/files-node/api/file-tree/projects/p1/files/upload');
  await api.readFile('p1', '/repo/a');
  expect(fetchMock.mock.calls.at(-1)?.[0]).toMatch(/^\/cloudcli\/chat-node\//);
});

test.each(['https://outside.invalid/', '//outside.invalid/', '/cloudcli/../', '/api/'])('file scope rejects %s before sending credentials', (apiBasePath) => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect(() => api.readFile('p1', '/repo/file', { apiBasePath })).toThrow('Invalid file API scope');
  expect(() => api.uploadFilesUrl('p1', apiBasePath)).toThrow('Invalid file API scope');
  expect(fetchMock).not.toHaveBeenCalled();
});
