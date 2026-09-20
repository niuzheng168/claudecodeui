import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { TranscriptProjectContext } from '@/modules/chat/context/TranscriptProjectContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import { storeAuthToken } from '@/shared/authToken';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project } from '@/shared/types';

const NativeURL = URL;
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const fetchImage = vi.fn();
const imageResponse = () => new Response(new Uint8Array([137, 80, 78, 71]), {
  headers: { 'Content-Type': 'image/png' },
});

beforeEach(() => {
  let nextId = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:project-image-${++nextId}`);
  revokeObjectURL.mockReset();
  fetchImage.mockReset().mockImplementation(async () => imageResponse());
  vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, { createObjectURL, revokeObjectURL }));
  vi.stubGlobal('fetch', fetchImage);
  localStorage.clear();
  storeAuthToken('fixture.payload.signature');
});

afterEach(() => {
  // Unmount before restoring URL so effect cleanup still uses the captured stub.
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__;
  localStorage.clear();
});

function markdown(content: string, projectId: string | null = 'project-itx') {
  return (
    <TranscriptProjectContext.Provider value={projectId}>
      <Markdown>{content}</Markdown>
    </TranscriptProjectContext.Provider>
  );
}

test('historical absolute image paths use authenticated node/project requests, never bare browser paths', async () => {
  (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__ = '/cloudcli/mac-node/';
  const imagePath = '/Users/owner/itx/output/bkb/presentation/current_exterior.png';
  const view = render(markdown(`![当前机箱外观](${imagePath})`));
  expect(view.container.querySelector('img')).toBeNull();

  const image = await screen.findByRole('img', { name: '当前机箱外观' });
  expect(image.getAttribute('src')).toBe('blob:project-image-1');
  expect(fetchImage).toHaveBeenCalledTimes(1);
  const [url, options] = fetchImage.mock.calls[0];
  expect(url).toBe(`/cloudcli/mac-node/api/file-tree/projects/project-itx/files/content?${new URLSearchParams({ path: imagePath })}`);
  expect(options.headers.Authorization).toBe('Bearer fixture.payload.signature');
  expect(options.cache).toBe('no-store');
  expect(options.signal.aborted).toBe(false);
  expect(url).not.toContain('/api/assets/');

  view.unmount();
  expect(options.signal.aborted).toBe(true);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:project-image-1');
});

test('Portal SSO reads the same node API without adding a stale standalone token', async () => {
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  render(markdown('![Layout](output/layout.png)'));
  await screen.findByRole('img', { name: 'Layout' });
  expect(fetchImage.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

test.each([
  ['output/render.png', 'output/render.png'],
  ['./output/render.png', './output/render.png'],
  ['../other/render.png', '../other/render.png'],
  ['/home/owner/render.png', '/home/owner/render.png'],
  ['/Users/owner/output/case%20%23%E6%9C%BA%E7%AE%B1.png', '/Users/owner/output/case #机箱.png'],
  ['output/100%2520.png', 'output/100%20.png'],
  ['output/render.png?download=1#preview', 'output/render.png'],
  ['file:///Users/owner/output/render%20one.png', '/Users/owner/output/render one.png'],
  ['file://localhost/home/owner/render.png', '/home/owner/render.png'],
  ['sandbox:/home/owner/render.png', '/home/owner/render.png'],
  ['C:/Users/owner/render.png', 'C:/Users/owner/render.png'],
  ['C:\\Users\\owner\\render.png', 'C:\\Users\\owner\\render.png'],
  ['file:///C:/Users/owner/render.png', 'C:/Users/owner/render.png'],
])('resolves %s once and leaves filesystem authorization to the existing project API', async (src, expectedPath) => {
  render(markdown(`![Render](<${src}>)`));
  await screen.findByRole('img', { name: 'Render' });
  expect(new URL(fetchImage.mock.calls[0][0], 'https://portal.test').searchParams.get('path')).toBe(expectedPath);
});

test.each(['https://cdn.example.test/render.png', 'http://cdn.example.test/render.png', '//cdn.example.test/render.png'])(
  'external image %s stays a browser image without node credentials',
  (src) => {
    render(markdown(`![Public](${src})`));
    expect(screen.getByRole('img', { name: 'Public' }).getAttribute('src')).toBe(src);
    expect(fetchImage).not.toHaveBeenCalled();
  },
);

test.each([
  'javascript:alert%281%29', 'vbscript:msgbox%281%29', 'data:text/html;base64,PHNjcmlwdD4=',
  'data:image/svg+xml;base64,PHN2Zz4=', 'blob:https://other.test/image', 'ftp://other.test/image.png',
  'file://other.test/share/image.png', 'sandbox://other.test/image.png', 'output/%00.png', '#image',
])('never fetches or renders unsafe/unsupported image source %s', (src) => {
  const view = render(markdown(`![Unsafe](<${src}>)`));
  expect(view.container.querySelector('img')).toBeNull();
  expect(fetchImage).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('Image unavailable');
});

test('image support does not disable Markdown link sanitization', () => {
  const view = render(markdown('[Unsafe](javascript:alert%281%29) [Data](data:text/html,test)'));
  for (const link of view.container.querySelectorAll('a')) {
    expect(link.getAttribute('href')).toBe('');
  }
});

test('no project means no filesystem or global-asset lookup', () => {
  render(markdown('![Local](/Users/owner/render.png)', null));
  expect(fetchImage).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('Image unavailable');
  expect(screen.queryByRole('button')).toBeNull();
});

test.each([403, 404, 502])('an HTTP %i remains retryable after the node or file becomes available', async (status) => {
  fetchImage.mockResolvedValueOnce(new Response('Unavailable', { status }));
  render(markdown('![Layout](output/layout.png)'));
  const retry = await screen.findByRole('button', { name: 'Retry image' });
  expect(createObjectURL).not.toHaveBeenCalled();
  fireEvent.click(retry);
  expect((await screen.findByRole('img', { name: 'Layout' })).getAttribute('src')).toBe('blob:project-image-1');
  expect(fetchImage).toHaveBeenCalledTimes(2);
});

test('a successful HTML login/error response is not turned into a broken image', async () => {
  fetchImage.mockResolvedValueOnce(new Response('<html>Login</html>', {
    headers: { 'Content-Type': 'text/html' },
  }));
  render(markdown('![Layout](output/layout.png)'));
  await screen.findByRole('button', { name: 'Retry image' });
  expect(createObjectURL).not.toHaveBeenCalled();
});

test('a network failure and a browser decode failure can each be retried', async () => {
  fetchImage.mockRejectedValueOnce(new TypeError('Network unavailable'));
  render(markdown('![Layout](output/layout.png)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry image' }));
  fireEvent.error(await screen.findByRole('img', { name: 'Layout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  expect((await screen.findByRole('img', { name: 'Layout' })).getAttribute('src')).toBe('blob:project-image-2');
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:project-image-1');
});

test('changing projects or paths hides and revokes the previous image before showing the new one', async () => {
  const view = render(markdown('![Layout](output/one.png)', 'project-one'));
  await screen.findByRole('img', { name: 'Layout' });
  view.rerender(markdown('![Layout](output/two.png)', 'project-two'));
  expect(screen.queryByRole('img', { name: 'Layout' })).toBeNull();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:project-image-1');
  await screen.findByRole('img', { name: 'Layout' });
  expect(fetchImage.mock.calls[1][0]).toContain('/projects/project-two/');
  expect(new URL(fetchImage.mock.calls[1][0], 'https://portal.test').searchParams.get('path')).toBe('output/two.png');
});

test('an unmounted in-flight blob read cannot leak an object URL or replace a newer image', async () => {
  let finishBlob!: (blob: Blob) => void;
  const blob = imageResponse().blob();
  const oldResponse = imageResponse();
  vi.spyOn(oldResponse, 'blob').mockImplementation(() => new Promise<Blob>((resolve) => { finishBlob = resolve; }));
  fetchImage.mockResolvedValueOnce(oldResponse);
  const view = render(markdown('![Layout](output/old.png)'));
  await waitFor(() => expect(oldResponse.blob).toHaveBeenCalled());

  view.rerender(markdown('![Layout](output/new.png)'));
  expect(fetchImage.mock.calls[0][1].signal.aborted).toBe(true);
  await screen.findByRole('img', { name: 'Layout' });
  await act(async () => { finishBlob(await blob); });
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('img', { name: 'Layout' }).getAttribute('src')).toBe('blob:project-image-1');
});

test('settled and pending streaming Markdown both inherit the transcript project', async () => {
  render(
    <TranscriptProjectContext.Provider value="stream-project">
      <StreamingMarkdown content={'![Settled](output/one.png)\n\n![Pending](output/two.png)'} isStreaming />
    </TranscriptProjectContext.Provider>,
  );
  await screen.findByRole('img', { name: 'Settled' });
  await screen.findByRole('img', { name: 'Pending' });
  expect(fetchImage).toHaveBeenCalledTimes(2);
  for (const [url] of fetchImage.mock.calls) expect(url).toContain('/projects/stream-project/');
});

test.each([false, true])('MessageComponent supplies the selected project for assistant images (streaming=%s)', async (isStreaming) => {
  const project: Project = { projectId: 'selected-project', fullPath: '/workspace', displayName: 'Workspace' };
  const message: ChatMessage = {
    type: 'assistant', content: '![Rendered](output/render.png)', isStreaming,
    timestamp: '2026-09-20T00:00:00.000Z',
  };
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex" selectedProject={project} />
    </UiPreferencesProvider>,
  );
  await screen.findByRole('img', { name: 'Rendered' });
  expect(fetchImage.mock.calls[0][0]).toContain('/projects/selected-project/');
});
