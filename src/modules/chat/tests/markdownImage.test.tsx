import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { TranscriptProjectContext } from '@/modules/chat/context/TranscriptProjectContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';

const readFileBlob = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
}));

/**
 * Chat markdown that references an image by workspace path has to be fetched
 * through the authenticated files route: a bare <img src="imagenes/x.png">
 * resolves against the web origin and 404s. Web URLs keep loading directly.
 * Path handling details (./, file:, encoded names) live in markdownImages.test.tsx.
 */

const OBJECT_URL = 'blob:mock-image';
// jsdom has no object URLs at all, so these are stubbed for the whole file
// rather than restored per test: React's unmount cleanup, which revokes the
// URL, runs from the setup file's afterEach after this file's hooks.
const createObjectURL = vi.fn(() => OBJECT_URL);
const revokeObjectURL = vi.fn();
URL.createObjectURL = createObjectURL;
URL.revokeObjectURL = revokeObjectURL;

beforeEach(() => {
  readFileBlob.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

const renderInProject = (markdown: string, projectId: string | null = 'project-1') =>
  render(
    <TranscriptProjectContext.Provider value={projectId}>
      <Markdown>{markdown}</Markdown>
    </TranscriptProjectContext.Provider>,
  );

// The reader only accepts image responses, so a login page is never shown as one.
const imageResponse = (ok = true) => ({
  ok,
  headers: new Headers({ 'content-type': ok ? 'image/png' : 'text/html' }),
  blob: async () => new Blob(['png']),
});

test('a workspace image path is fetched through the project files route and shown as a blob', async () => {
  readFileBlob.mockResolvedValue(imageResponse());

  const { findByRole } = renderInProject('Aquí la tienes:\n\n![gato naranja](imagenes/gato.png)\n');

  const img = (await findByRole('img')) as HTMLImageElement;
  assert.equal(img.getAttribute('src'), OBJECT_URL);
  assert.equal(img.alt, 'gato naranja');
  assert.equal(readFileBlob.mock.calls.length, 1);
  assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['project-1', 'imagenes/gato.png']);
});

test('web URLs are left to the browser', () => {
  const { getByRole } = renderInProject('![logo](https://example.com/logo.png)');

  const img = getByRole('img') as HTMLImageElement;
  assert.equal(img.getAttribute('src'), 'https://example.com/logo.png');
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('a missing file falls back to the alt text instead of a broken image', async () => {
  readFileBlob.mockResolvedValue(imageResponse(false));

  const { findByText, queryByRole } = renderInProject('![gato](imagenes/nada.png)');

  await findByText('gato');
  assert.equal(queryByRole('img'), null);
});

test('without a project the path cannot be resolved and the alt text is shown', async () => {
  const { findByText } = renderInProject('![gato](imagenes/gato.png)', null);

  await findByText('gato');
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('the image is revoked when the markdown unmounts', async () => {
  readFileBlob.mockResolvedValue(imageResponse());

  const { findByRole, unmount } = renderInProject('![gato](imagenes/gato.png)');
  await findByRole('img');
  unmount();

  await waitFor(() => assert.equal(revokeObjectURL.mock.calls[0]?.[0], OBJECT_URL));
});
