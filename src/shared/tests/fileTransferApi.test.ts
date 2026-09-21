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
