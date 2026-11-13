import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownPreviewControl } from '@/modules/chat/transcript/MarkdownPreviewControl';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';
import * as sharedUtils from '@/shared/utils';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mermaid.initialize.mockReset();
  mermaid.render.mockReset().mockResolvedValue({ svg: '<svg role="img" aria-label="Diagram"><text>A to B</text></svg>' });
});

function Providers({ children }: { children: ReactNode }) {
  return <ThemeProvider><UiPreferencesProvider>{children}</UiPreferencesProvider></ThemeProvider>;
}

function message(content: string, type: 'user' | 'assistant' = 'assistant', extra: Partial<ChatMessage> = {}) {
  return (
    <MessageComponent
      message={{ type, content, timestamp: '2026-11-13T10:00:00Z', ...extra }}
      prevMessage={null}
      createDiff={() => []}
      provider="claude"
    />
  );
}

test.each([
  '# Heading',
  'Title\n===',
  'Title\n--',
  '    indented code',
  '- One\n- Two',
  '1. One\n2. Two',
  '> Quote',
  '**粗体** and ~~deleted~~',
  'An *italic* word',
  '中文*斜体*测试',
  '`inlineCode`',
  '[Link](https://example.test)',
  '![Diagram](image.png)',
  '[guide]\n\n[guide]: https://example.test',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '```mermaid\nflowchart LR\nA --> B\n```',
  '$$x^2$$',
])('offers preview for Markdown syntax: %s', (content) => {
  render(<MarkdownPreviewControl content={content} />);
  expect(screen.queryByRole('button', { name: 'Markdown preview' })).not.toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test.each(['', '  ', '你好，请解释一下这段代码。', 'Ordinary text\nwith another line.', 'file_name.ts costs $5'])(
  'does not add a preview button to plain text: %s',
  (content) => {
    render(<MarkdownPreviewControl content={content} />);
    expect(screen.queryByRole('button')).toBeNull();
  },
);

test.each(['user', 'assistant'] as const)('opens a portaled document beside the %s message controls', async (type) => {
  const content = '# Report\n\n| Item | Status |\n| --- | --- |\n| Preview | Ready |\n\n- [x] Tested';
  const view = render(<Providers>{message(content, type)}</Providers>);
  const trigger = screen.getByRole('button', { name: 'Markdown preview' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Markdown preview' });
  expect(view.container.contains(dialog)).toBe(false);
  expect(await within(dialog).findByRole('heading', { name: 'Report' })).not.toBeNull();
  // Tailwind's not-prose disables typography even for nested prose containers.
  expect(dialog.querySelector('.prose')?.closest('.not-prose')).toBeNull();
  expect(within(dialog).getByRole('table').textContent).toContain('PreviewReady');
  expect(within(dialog).getByRole('checkbox').hasAttribute('checked')).toBe(true);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }));
  expect(dialog.querySelector('pre')?.textContent).toBe(content);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
  expect(within(dialog).getByRole('heading', { name: 'Report' })).not.toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement === trigger).toBe(true);
  expect(document.body.style.overflow).not.toBe('hidden');
});

test('a Markdown code block renders its document and nested Mermaid only after opening preview', async () => {
  const source = '# Flow\n\n```mermaid\nflowchart LR\nA --> B\n```';
  const content = `\`\`\`\`markdown\n${source}\n\`\`\`\``;
  render(<Providers><Markdown>{content}</Markdown></Providers>);
  expect(mermaid.render).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  const dialog = screen.getByRole('dialog');
  expect(await within(dialog).findByRole('heading', { name: 'Flow' })).not.toBeNull();
  expect(await within(dialog).findByRole('img', { name: 'Diagram' })).not.toBeNull();
  expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }));
  expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), 'flowchart LR\nA --> B');
  expect(within(dialog).queryByRole('button', { name: 'Markdown preview' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }));
  expect(dialog.querySelector('pre')?.textContent).toBe(source);
});

test('whole-message preview renders Markdown fences as documents without discarding surrounding prose', async () => {
  const content = 'Here is the document:\n\n```md\n# Document title\n\n**Important**\n```\n\nEnd of message.';
  render(<Providers>{message(content)}</Providers>);
  const triggers = screen.getAllByRole('button', { name: 'Markdown preview' });
  fireEvent.click(triggers[triggers.length - 1]);
  const dialog = screen.getByRole('dialog');
  expect(await within(dialog).findByRole('heading', { name: 'Document title' })).not.toBeNull();
  expect(dialog.textContent).toContain('Here is the document:');
  expect(dialog.textContent).toContain('End of message.');
  expect(within(dialog).queryByRole('button', { name: 'Markdown preview' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }));
  expect(dialog.querySelector('pre')?.textContent).toBe(content);
});

test.each(['md', 'MARKDOWN', 'mdown', 'mkd', ''])('previews Markdown inside a %s code fence', async (language) => {
  render(<Providers><Markdown>{`\`\`\`${language}\n# Preview me\n\`\`\``}</Markdown></Providers>);
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  expect(await within(screen.getByRole('dialog')).findByRole('heading', { name: 'Preview me' })).not.toBeNull();
});

test('a standalone Mermaid block has an expanded preview and keeps its source on parse failure', async () => {
  mermaid.render.mockRejectedValue(new Error('Incomplete diagram'));
  const source = 'flowchart LR\nA -->';
  render(<Providers><Markdown>{`\`\`\`mermaid\n${source}\n\`\`\``}</Markdown></Providers>);
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('button', { name: 'Source' });
  await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
  expect(dialog.querySelector('pre')?.textContent).toBe(source);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('opening preview leaves the transcript DOM alone and follows streamed content updates', async () => {
  const view = render(<Providers>{message('# Growing', 'assistant', { isStreaming: true })}</Providers>);
  const originalHeading = within(view.container).getByRole('heading', { name: 'Growing' });
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('heading', { name: 'Growing' });
  expect(within(view.container).getByRole('heading', { name: 'Growing' }) === originalHeading).toBe(true);
  view.rerender(<Providers>{message('# Growing\n\nFinished.', 'assistant', { isStreaming: false })}</Providers>);
  expect(within(dialog).getByText('Finished.')).not.toBeNull();
  expect(screen.getByRole('dialog') === dialog).toBe(true);
});

test('exported messages and code blocks contain no preview controls', () => {
  render(
    <Providers>
      <TranscriptRenderContext.Provider value={{ isExporting: true }}>
        {message('# Report\n\n```markdown\n# Nested\n```')}
      </TranscriptRenderContext.Provider>
    </Providers>,
  );
  expect(screen.queryByRole('button', { name: 'Markdown preview' })).toBeNull();
});

test('preview preserves the Markdown sanitizer instead of executing raw HTML', async () => {
  render(
    <Providers>
      <MarkdownPreviewControl content={'# Unsafe\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)'} />
    </Providers>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('heading', { name: 'Unsafe' });
  expect(dialog.querySelector('script')).toBeNull();
  expect(dialog.querySelector('a[href^="javascript:"]')).toBeNull();
});

test('zoom magnifies preview content while source remains unscaled', async () => {
  render(<Providers><MarkdownPreviewControl content="# Document" /></Providers>);
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  const dialog = screen.getByRole('dialog');
  const zoom = await within(dialog).findByRole('combobox', { name: 'Preview zoom' });
  fireEvent.change(zoom, { target: { value: '200' } });
  expect(dialog.querySelector<HTMLElement>('.prose')?.parentElement?.style.zoom).toBe('2');
  expect(dialog.querySelector<HTMLElement>('.prose')?.parentElement?.style.width).toBe('200%');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }));
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  expect(dialog.querySelector('pre')?.textContent).toBe('# Document');
  expect(dialog.querySelector('pre')?.parentElement?.hasAttribute('style')).toBe(false);
});

test('copying from preview preserves the original Markdown and Mermaid source', async () => {
  const copy = vi.spyOn(sharedUtils, 'copyTextToClipboard').mockResolvedValue(true);
  const content = '# Flow\n\n```mermaid\nflowchart LR\nA --> B\n```';
  render(<Providers><MarkdownPreviewControl content={content} /></Providers>);
  fireEvent.click(screen.getByRole('button', { name: 'Markdown preview' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy message' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(content));
});

test('the preview controls are localized in Chinese', async () => {
  await i18n.changeLanguage('zh-CN');
  render(<Providers><MarkdownPreviewControl content="# 文档" /></Providers>);
  fireEvent.click(screen.getByRole('button', { name: 'Markdown 预览' }));
  const dialog = screen.getByRole('dialog', { name: 'Markdown 预览' });
  expect(await within(dialog).findByRole('button', { name: '源码' })).not.toBeNull();
  expect(within(dialog).getByRole('button', { name: '关闭预览' })).not.toBeNull();
});
