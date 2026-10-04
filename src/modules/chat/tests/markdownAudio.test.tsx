import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { TranscriptProjectContext } from '@/modules/chat/context/TranscriptProjectContext';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { storeAuthToken } from '@/shared/authToken';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project } from '@/shared/types';

const NativeURL = URL;
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const fetchAudio = vi.fn();
const audioResponse = (contentType = 'audio/mpeg') => new Response(new Uint8Array([73, 68, 51, 1]), {
  headers: { 'Content-Type': contentType },
});

beforeEach(() => {
  let nextId = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:chat-audio-${++nextId}`);
  revokeObjectURL.mockReset();
  fetchAudio.mockReset().mockImplementation(async () => audioResponse());
  vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, { createObjectURL, revokeObjectURL }));
  vi.stubGlobal('fetch', fetchAudio);
  localStorage.clear();
  storeAuthToken('fixture.payload.signature');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__;
  localStorage.clear();
});

function markdown(content: string, projectId: string | null = 'project-audio') {
  return (
    <TranscriptProjectContext.Provider value={projectId}>
      <Markdown>{content}</Markdown>
    </TranscriptProjectContext.Provider>
  );
}

function AudioFileLinkHandler({ children, onOpen }: { children: ReactNode; onOpen: (path: string) => void }) {
  usePaletteOpsRegister({ openFileInEditor: onOpen });
  return <>{children}</>;
}

test('project audio links render authenticated in-message players without autoplay and release their blobs', async () => {
  (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__ = '/cloudcli/audio-node/';
  const path = '/home/owner/project/output/demo.mp3';
  const view = render(markdown(`[Preview](${path})`));
  expect(view.container.querySelector('audio')).toBeNull();

  const player = await screen.findByLabelText('Audio player: Preview');
  expect(player.getAttribute('src')).toBe('blob:chat-audio-1');
  expect(player.hasAttribute('controls')).toBe(true);
  expect(player.getAttribute('preload')).toBe('none');
  expect(player.hasAttribute('autoplay')).toBe(false);
  expect(screen.getByRole('link', { name: 'Preview' }).getAttribute('href')).toBe(path);
  const [url, options] = fetchAudio.mock.calls[0];
  expect(url).toBe(`/cloudcli/audio-node/api/file-tree/projects/project-audio/files/content?${new URLSearchParams({ path })}`);
  expect(options.headers.Authorization).toBe('Bearer fixture.payload.signature');
  expect(options.cache).toBe('no-store');

  view.unmount();
  expect(options.signal.aborted).toBe(true);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:chat-audio-1');
});

test('Portal SSO audio uses the node API without a stale standalone bearer token', async () => {
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  render(markdown('[Preview](output/demo.mp3)'));
  await screen.findByLabelText('Audio player: Preview');
  expect(fetchAudio.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

test('the audio title still opens the literal file path in the existing preview panel', async () => {
  const onOpen = vi.fn();
  render(
    <PaletteOpsProvider>
      <AudioFileLinkHandler onOpen={onOpen}>
        {markdown('[Preview](file:///home/owner/audio%20demo.mp3)')}
      </AudioFileLinkHandler>
    </PaletteOpsProvider>,
  );
  await screen.findByLabelText('Audio player: Preview');
  fireEvent.click(screen.getByRole('link', { name: 'Preview' }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('/home/owner/audio demo.mp3');
});

test.each([
  ['output/%E8%AF%AD%E9%9F%B3%20%23one%3Ftwo.mp3', 'output/语音 #one?two.mp3'],
  ['output/100%2520.mp3', 'output/100%20.mp3'],
  ['output/demo.mp3?download=1#preview', 'output/demo.mp3'],
  ['file:///Users/owner/output/demo.mp3', '/Users/owner/output/demo.mp3'],
  ['sandbox:/home/owner/output/demo.mp3', '/home/owner/output/demo.mp3'],
  ['C:/Users/owner/output/demo.mp3', 'C:/Users/owner/output/demo.mp3'],
  ['file:///C:/Users/owner/output/demo.mp3', 'C:/Users/owner/output/demo.mp3'],
])('audio link %s survives Markdown sanitization only for its authorized file path', async (href, path) => {
  render(markdown(`[Preview](<${href}>)`));
  await screen.findByLabelText('Audio player: Preview');
  expect(new URL(fetchAudio.mock.calls[0][0], 'https://portal.test').searchParams.get('path')).toBe(path);
});

test.each([
  'https://cdn.example.test/demo.mp3?signature=abc#t=10',
  'http://cdn.example.test/demo.wav',
  '//cdn.example.test/demo.ogg',
])('public audio %s is a native player and never receives node authentication', (href) => {
  render(markdown(`[Preview](${href})`));
  expect(screen.getByLabelText('Audio player: Preview').getAttribute('src')).toBe(href);
  expect(fetchAudio).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Preview' }).getAttribute('rel')).toBe('noopener noreferrer');
});

test.each([
  'javascript:demo.mp3',
  'data:audio/mpeg,demo.mp3',
  'blob:https://portal.test/demo.mp3',
  'file://other-node/demo.mp3',
  'sandbox://other-node/demo.mp3',
  'output/%E0%A4.mp3',
])('unsafe or malformed audio link %s never creates a player or an authenticated request', (href) => {
  const view = render(markdown(`[Unsafe](<${href}>)`));
  expect(view.container.querySelector('audio')).toBeNull();
  expect(fetchAudio).not.toHaveBeenCalled();
});

test('missing project context does not fall back to the global attachment store', () => {
  render(markdown('[Preview](output/demo.mp3)', null));
  expect(fetchAudio).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('Audio unavailable');
  expect(screen.queryByRole('button', { name: 'Retry audio' })).toBeNull();
});

test.each([403, 404, 502])('an HTTP %i can be retried after the node or file becomes available', async (status) => {
  fetchAudio.mockResolvedValueOnce(new Response('Unavailable', { status }));
  render(markdown('[Preview](output/demo.mp3)'));
  const retry = await screen.findByRole('button', { name: 'Retry audio' });
  expect(createObjectURL).not.toHaveBeenCalled();
  fireEvent.click(retry);
  expect((await screen.findByLabelText('Audio player: Preview')).getAttribute('src')).toBe('blob:chat-audio-1');
  expect(fetchAudio).toHaveBeenCalledTimes(2);
});

test.each(['text/html', 'application/json'])('a successful %s login/error response is not treated as audio', async (contentType) => {
  fetchAudio.mockResolvedValueOnce(new Response('Login required', { headers: { 'Content-Type': contentType } }));
  render(markdown('[Preview](output/demo.mp3)'));
  await screen.findByRole('button', { name: 'Retry audio' });
  expect(createObjectURL).not.toHaveBeenCalled();
});

test.each([
  ['demo.flac', 'application/octet-stream', 'audio/flac'],
  ['demo.wav', '', 'audio/wav'],
  ['demo.ogg', 'application/ogg', 'audio/ogg'],
  ['demo.m4a', 'video/mp4', 'audio/mp4'],
  ['demo.weba', 'video/webm', 'audio/webm'],
])('audio %s replaces generic/container MIME %s with %s', async (filename, contentType, playbackType) => {
  fetchAudio.mockResolvedValueOnce(audioResponse(contentType));
  render(markdown(`[Preview](output/${filename})`));
  await screen.findByLabelText('Audio player: Preview');
  expect(createObjectURL.mock.calls[0][0].type).toBe(playbackType);
});

test('an empty audio file stays retryable instead of creating a broken player', async () => {
  fetchAudio.mockResolvedValueOnce(new Response(null, { headers: { 'Content-Type': 'audio/mpeg' } }));
  render(markdown('[Preview](output/demo.mp3)'));
  await screen.findByRole('button', { name: 'Retry audio' });
  expect(createObjectURL).not.toHaveBeenCalled();
});

test('a browser decoding error preserves the file link and retries with a new blob', async () => {
  render(markdown('[Preview](output/demo.mp3)'));
  fireEvent.error(await screen.findByLabelText('Audio player: Preview'));
  expect(screen.getByRole('link', { name: 'Preview' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry audio' }));
  expect((await screen.findByLabelText('Audio player: Preview')).getAttribute('src')).toBe('blob:chat-audio-2');
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:chat-audio-1');
});

test('retrying a public audio error recreates the native player without credentialed fetching', () => {
  const href = 'https://cdn.example.test/demo.mp3';
  render(markdown(`[Preview](${href})`));
  const player = screen.getByLabelText('Audio player: Preview');
  fireEvent.error(player);
  expect(screen.queryByLabelText('Audio player: Preview')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry audio' }));
  const retried = screen.getByLabelText('Audio player: Preview');
  expect(retried).not.toBe(player);
  expect(retried.getAttribute('src')).toBe(href);
  expect(fetchAudio).not.toHaveBeenCalled();
});

test('changing the project and file hides, aborts, and revokes the previous audio', async () => {
  const view = render(markdown('[Preview](output/one.mp3)', 'project-one'));
  await screen.findByLabelText('Audio player: Preview');
  view.rerender(markdown('[Preview](output/two.mp3)', 'project-two'));
  expect(screen.queryByLabelText('Audio player: Preview')).toBeNull();
  expect(fetchAudio.mock.calls[0][1].signal.aborted).toBe(true);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:chat-audio-1');
  expect((await screen.findByLabelText('Audio player: Preview')).getAttribute('src')).toBe('blob:chat-audio-2');
  expect(fetchAudio.mock.calls[1][0]).toContain('/projects/project-two/');
});

test('a late blob read after a source change cannot leak a URL or replace current audio', async () => {
  let finishBlob!: (blob: Blob) => void;
  const response = audioResponse();
  vi.spyOn(response, 'blob').mockImplementation(() => new Promise<Blob>((resolve) => { finishBlob = resolve; }));
  fetchAudio.mockResolvedValueOnce(response);
  const view = render(markdown('[Preview](output/old.mp3)'));
  await waitFor(() => expect(response.blob).toHaveBeenCalled());
  view.rerender(markdown('[Preview](output/new.mp3)'));
  await screen.findByLabelText('Audio player: Preview');
  await act(async () => { finishBlob(await audioResponse().blob()); });
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Audio player: Preview').getAttribute('src')).toBe('blob:chat-audio-1');
});

test('rerendering an unchanged audio link retains its player and does not refetch it', async () => {
  const view = render(markdown('[Preview](output/demo.mp3)'));
  const player = await screen.findByLabelText('Audio player: Preview');
  view.rerender(markdown('[Preview](output/demo.mp3)\n\nMore text'));
  expect(screen.getByLabelText('Audio player: Preview')).toBe(player);
  expect(fetchAudio).toHaveBeenCalledTimes(1);
});

test('settled and pending streaming Markdown both inherit the transcript project for audio', async () => {
  render(
    <TranscriptProjectContext.Provider value="stream-project">
      <StreamingMarkdown content={'[First](output/one.mp3)\n\n[Second](output/two.mp3)'} isStreaming />
    </TranscriptProjectContext.Provider>,
  );
  await screen.findByLabelText('Audio player: First');
  await screen.findByLabelText('Audio player: Second');
  expect(fetchAudio).toHaveBeenCalledTimes(2);
  for (const [url] of fetchAudio.mock.calls) expect(url).toContain('/projects/stream-project/');
});

test.each([false, true])('assistant messages supply the selected project for audio (streaming=%s)', async (isStreaming) => {
  const project: Project = { projectId: 'selected-project', fullPath: '/workspace', displayName: 'Workspace' };
  const message: ChatMessage = {
    type: 'assistant', content: '[Preview](output/demo.mp3)', isStreaming,
    timestamp: '2026-10-04T00:00:00.000Z',
  };
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex" selectedProject={project} />
    </UiPreferencesProvider>,
  );
  await screen.findByLabelText('Audio player: Preview');
  expect(fetchAudio.mock.calls[0][0]).toContain('/projects/selected-project/');
});

test('uploaded audio previews use the authenticated attachment API and retain downloads', async () => {
  const clickDownload = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const view = render(<ChatMessageFiles files={[{ path: '/assets/stored recording.mp3', name: 'recording.mp3', size: 1024 }]} />);
  await screen.findByLabelText('Audio player: recording.mp3');
  expect(fetchAudio.mock.calls[0][0]).toBe('/api/assets/files/stored%20recording.mp3');
  expect(fetchAudio.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture.payload.signature');
  expect(screen.getByText('1 KB')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Download recording.mp3' }));
  await waitFor(() => expect(clickDownload).toHaveBeenCalledOnce());
  expect(fetchAudio).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(fetchAudio.mock.calls[0][1].signal.aborted).toBe(true);
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:chat-audio-1');
});

test('audio attachment MIME metadata supports recordings without an extension', async () => {
  fetchAudio.mockResolvedValueOnce(audioResponse('application/octet-stream'));
  render(<ChatMessageFiles files={[{ path: '/assets/recording', name: 'Voice note', mimeType: 'audio/webm' }]} />);
  await screen.findByLabelText('Audio player: Voice note');
  expect(createObjectURL.mock.calls[0][0].type).toBe('audio/webm');
});

test('ordinary file attachments remain download cards without automatic fetching', () => {
  const view = render(<ChatMessageFiles files={[{ path: '/assets/report.zip', name: 'report.zip' }]} />);
  expect(screen.getByRole('button', { name: 'Download report.zip' })).toBeTruthy();
  expect(view.container.querySelector('audio')).toBeNull();
  expect(fetchAudio).not.toHaveBeenCalled();
});
