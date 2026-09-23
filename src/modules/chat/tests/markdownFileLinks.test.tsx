import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { api } from '@/shared/api';

function FileLinkHandler({ children, onOpen }: { children: ReactNode; onOpen: (path: string) => void }) {
  usePaletteOpsRegister({ openFileInEditor: onOpen });
  return <>{children}</>;
}

function renderFileLinks(children: ReactNode, onOpen = vi.fn<(path: string) => void>()) {
  const view = render(
    <PaletteOpsProvider>
      <FileLinkHandler onOpen={onOpen}>{children}</FileLinkHandler>
    </PaletteOpsProvider>,
  );
  return { ...view, onOpen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([
  [
    '/Users/owner/itx/diy机箱全部资料合集_20241018_211646/解压记录.json',
    '/Users/owner/itx/diy机箱全部资料合集_20241018_211646/解压记录.json',
  ],
  [
    '/Users/owner/itx/diy%E6%9C%BA%E7%AE%B1%E5%85%A8%E9%83%A8%E8%B5%84%E6%96%99%E5%90%88%E9%9B%86_20241018_211646/%E8%A7%A3%E5%8E%8B%E8%AE%B0%E5%BD%95.json',
    '/Users/owner/itx/diy机箱全部资料合集_20241018_211646/解压记录.json',
  ],
  ['解压记录.json', '解压记录.json'],
  ['./资料/解压记录.json', './资料/解压记录.json'],
  ['output/解压 记录.json', 'output/解压 记录.json'],
  ['output/100%25.json', 'output/100%.json'],
  ['output/literal%2520.json', 'output/literal%20.json'],
  ['output/literal%252F.json', 'output/literal%2F.json'],
  ['output/记录%23one%3Ftwo.json', 'output/记录#one?two.json'],
  ['output/记录.json:12:3', 'output/记录.json'],
  ['output/literal.json%3A12', 'output/literal.json:12'],
  ['output/%E0%A4.json', 'output/%E0%A4.json'],
])('opens the literal filesystem path for Markdown href %s', (href, expectedPath) => {
  const { onOpen } = renderFileLinks(<Markdown>{`[Open](<${href}>)`}</Markdown>);
  fireEvent.click(screen.getByRole('link', { name: 'Open' }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(expectedPath);
});

test.each([
  ['[解压记录.json]()', '解压记录.json'],
  ['[`output/literal%20.json`]()', 'output/literal%20.json'],
  ['[output/记录.json:12:3]()', 'output/记录.json'],
])('keeps fallback link text literal rather than URL-decoding it: %s', (content, expectedPath) => {
  const { onOpen } = renderFileLinks(<Markdown>{content}</Markdown>);
  fireEvent.click(screen.getByRole('link'));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(expectedPath);
});

test.each([false, true])('historical and streaming replies decode both settled and pending file links (streaming=%s)', (isStreaming) => {
  const content = '[First](output/解压记录.json)\n\n[Second](output/其他记录.json)';
  const { onOpen } = renderFileLinks(<StreamingMarkdown content={content} isStreaming={isStreaming} />);
  fireEvent.click(screen.getByRole('link', { name: 'First' }));
  fireEvent.click(screen.getByRole('link', { name: 'Second' }));
  expect(onOpen.mock.calls).toEqual([['output/解压记录.json'], ['output/其他记录.json']]);
});

test('the file API receives a decoded path while the DOM retains a URL-encoded href', async () => {
  const filePath = '/Users/owner/itx/diy机箱全部资料合集_20241018_211646/解压记录.json';
  const fetchFile = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: '{"records":[]}' })));
  vi.stubGlobal('fetch', fetchFile);
  const onOpen = vi.fn(async (path: string) => {
    const response = await api.readFile('project-itx', path);
    return response.json();
  });
  renderFileLinks(<Markdown>{`详细记录：[解压记录.json](${filePath})`}</Markdown>, onOpen);

  const link = screen.getByRole('link', { name: '解压记录.json' });
  expect(link.getAttribute('href')).toBe(encodeURI(filePath));
  fireEvent.click(link);
  await onOpen.mock.results[0].value;

  expect(fetchFile).toHaveBeenCalledTimes(1);
  const requestUrl = new URL(String(fetchFile.mock.calls[0][0]), 'https://workspace.test');
  expect(requestUrl.pathname).toBe('/api/file-tree/projects/project-itx/file');
  expect(requestUrl.searchParams.get('filePath')).toBe(filePath);
  expect(requestUrl.searchParams.get('filePath')).not.toContain('%E8');
});

test.each([
  'https://example.test/%E8%A7%A3%E5%8E%8B%E8%AE%B0%E5%BD%95.json',
  'http://example.test/report%20one.json',
  'mailto:owner@example.test',
  '#report',
])('external URL or anchor %s keeps browser navigation', (href) => {
  const { onOpen } = renderFileLinks(<Markdown>{`[解压记录.json](${href})`}</Markdown>);
  const link = screen.getByRole('link', { name: '解压记录.json' });
  expect(link.getAttribute('href')).toBe(href);
  expect(link.getAttribute('target')).toBe('_blank');
  // Suppress jsdom navigation without bypassing the component's click handler.
  link.addEventListener('click', (event) => event.preventDefault());
  fireEvent.click(link);
  expect(onOpen).not.toHaveBeenCalled();
});

test('file link decoding does not relax the Markdown URL sanitizer', () => {
  const { container } = renderFileLinks(
    <Markdown>{'[Unsafe](javascript:alert%281%29) [Data](data:text/html,test)'}</Markdown>,
  );
  for (const link of container.querySelectorAll('a')) {
    expect(link.getAttribute('href')).toBe('');
  }
});
