import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { TranscriptFollowupContext } from '@/modules/chat/context/TranscriptFollowupContext';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';

function FileHandler({ onOpen, children }: { onOpen: (path: string) => void; children: ReactNode }) {
  usePaletteOpsRegister({ openFileInEditor: onOpen });
  return <>{children}</>;
}

function fixture(content: ReactNode) {
  const onOpen = vi.fn<(path: string) => void>();
  const onFollowup = vi.fn<(prompt: string) => void>();
  const onSubmit = vi.fn((event) => event.preventDefault());
  const wrap = (children: ReactNode) => (
    <PaletteOpsProvider>
      <FileHandler onOpen={onOpen}>
        <TranscriptFollowupContext.Provider value={onFollowup}>
          <form onSubmit={onSubmit}>{children}</form>
        </TranscriptFollowupContext.Provider>
      </FileHandler>
    </PaletteOpsProvider>
  );
  const view = render(wrap(content));
  return { ...view, onOpen, onFollowup, onSubmit, rerenderContent: (children: ReactNode) => view.rerender(wrap(children)) };
}

const FILE_PATH = '/Users/operator/itx/ITX_2/FLEX_M/print-kit/FLEX_M_Trial_Print_Guide.pdf';
const PROMPT = '我发五金链接给你，请核对是否符合FLEX M试打清单。';
const FOLLOWUP = `:codex-followup[核对购买链接]{prompt="${PROMPT}"}`;
const CITATION = `:codex-file-citation{path="${FILE_PATH}" purpose="output"}`;

test.each([false, true])('renders the screenshot markers in historical and streaming replies (streaming=%s)', (isStreaming) => {
  const content = `包内附一页清单：${CITATION}\n\n- ${FOLLOWUP}\n- :codex-followup[指导热熔练习]{prompt="给我操作步骤。"}\n`;
  const { container, onOpen, onFollowup, onSubmit } = fixture(<StreamingMarkdown content={content} isStreaming={isStreaming} />);
  expect(container.textContent).not.toMatch(/:codex-|purpose=|prompt=/);
  expect(onOpen).not.toHaveBeenCalled();
  expect(onFollowup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'FLEX_M_Trial_Print_Guide.pdf' }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(FILE_PATH);
  fireEvent.click(screen.getByRole('button', { name: '核对购买链接' }));
  fireEvent.click(screen.getByRole('button', { name: '指导热熔练习' }));
  expect(onFollowup.mock.calls).toEqual([[PROMPT], ['给我操作步骤。']]);
  expect(onSubmit).not.toHaveBeenCalled();
});

test.each([
  ['output/中文 文件_name.pdf', '中文 文件_name.pdf'],
  ['output/literal%20%23.json', 'literal%20%23.json'],
  ['output/report#one?two.json', 'report#one?two.json'],
  ['output/100%.pdf', '100%.pdf'],
  ['C:/Users/owner/guide.pdf', 'guide.pdf'],
  [String.raw`C:\Users\owner\guide.pdf`, 'guide.pdf'],
  ['guide.pdf', 'guide.pdf'],
])('file citations preserve the literal path %s', (path, label) => {
  const { onOpen } = fixture(<Markdown>{`:codex-file-citation{path="${path}" purpose="output"}`}</Markdown>);
  const link = screen.getByRole('link', { name: label });
  expect(link.title).toBe(path);
  fireEvent.click(link);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(path);
});

test('file citations with labels and attributes in any order use the existing file operation', () => {
  const { onOpen } = fixture(
    <Markdown>{`:codex-file-citation[试打清单]{purpose='output' path='${FILE_PATH}'}`}</Markdown>,
  );
  fireEvent.click(screen.getByRole('link', { name: '试打清单' }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(FILE_PATH);
});

test.each([
  [`:codex-followup[Next]{prompt='Check "FLEX M", then {continue}.'}`, 'Check "FLEX M", then {continue}.'],
  [':codex-followup[Next]{prompt="Check &quot;FLEX M&quot; &amp; continue."}', 'Check "FLEX M" & continue.'],
  [':codex-followup[Next]{prompt="先检查\n然后继续"}', '先检查\n然后继续'],
  [':codex-followup{prompt="继续"}', '继续'],
])('decodes a quoted prompt without parsing it as Markdown: %s', (content, prompt) => {
  const { onFollowup } = fixture(<Markdown>{content}</Markdown>);
  fireEvent.click(screen.getByRole('button'));
  expect(onFollowup).toHaveBeenCalledExactlyOnceWith(prompt);
});

test.each([
  ':codex-followup[没有参数]',
  ':codex-followup[空建议]{prompt=""}',
  ':codex-followup[尚未完成]{prompt="继续',
  ':codex-file-citation{purpose="output"}',
  ':codex-file-citation{path=""}',
  ':codex-unknown[保留]{value="original"}',
  '::codex-unknown[保留]{value="original"}',
])('malformed, incomplete and unknown directives remain readable: %s', (content) => {
  const { container } = fixture(<Markdown>{content}</Markdown>);
  expect(container.textContent).toBe(content);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

test.each([
  'javascript:alert(1)',
  'data:text/html,test',
  'https://example.test/report.pdf',
  'file:///etc/passwd',
  'vbscript:msgbox(1)',
  ' javascript:alert(1)',
])('a file citation cannot activate URL scheme %s', (path) => {
  const content = `:codex-file-citation{path="${path}"}`;
  const { container, onOpen } = fixture(<Markdown>{content}</Markdown>);
  expect(container.textContent).toBe(content);
  expect(screen.queryByRole('link')).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

test('directive labels cannot introduce HTML, nested interactive controls or event handlers', () => {
  const { container, onFollowup } = fixture(
    <Markdown>{':codex-followup[[Next](https://example.test)]{prompt="&lt;img src=x onerror=alert(1)&gt;" onclick="alert(1)"}'}</Markdown>,
  );
  const button = screen.getByRole('button', { name: 'Next' });
  expect(container.querySelector('img, a, [onclick]')).toBeNull();
  expect(button.getAttribute('data-codex-followup')).toBeNull();
  fireEvent.click(button);
  expect(onFollowup).toHaveBeenCalledExactlyOnceWith('<img src=x onerror=alert(1)>');
});

test('normal links and unknown directive-like text keep their Markdown semantics beside Codex markers', () => {
  const { container } = fixture(
    <Markdown>{`see:[guide](https://example.test) :note[**important**]\n\n${FOLLOWUP}`}</Markdown>,
  );
  expect(screen.getByRole('link', { name: 'guide' }).getAttribute('href')).toBe('https://example.test');
  expect(container.querySelector('strong')?.textContent).toBe('important');
  expect(container.textContent).toContain(':note[important]');
  expect(screen.getByRole('button', { name: '核对购买链接' })).toBeTruthy();
});

test('directives inside an ordinary link remain text rather than nested controls', () => {
  const { onFollowup } = fixture(<Markdown>{`[${FOLLOWUP}](https://example.test)`}</Markdown>);
  expect(screen.getByRole('link').textContent).toBe(FOLLOWUP);
  expect(screen.queryByRole('button')).toBeNull();
  expect(onFollowup).not.toHaveBeenCalled();
});

test('inline code, fenced code, escaped markers and user-authored messages stay literal', () => {
  const content = `\`${FOLLOWUP}\`\n\n\`\`\`text\n${CITATION}\n\`\`\`\n\n\\${FOLLOWUP}`;
  const view = fixture(<Markdown>{content}</Markdown>);
  expect(view.container.textContent).toContain(FOLLOWUP);
  expect(view.container.textContent).toContain(CITATION);
  expect(screen.queryByRole('button', { name: '核对购买链接' })).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  view.rerenderContent(<Markdown breaks>{`${FOLLOWUP}\n${CITATION}`}</Markdown>);
  expect(view.container.textContent).toBe(`${FOLLOWUP}\n${CITATION}`);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

test('exports and renderers without a composer show readable labels, not dead controls or markup', () => {
  const { container } = render(<Markdown>{FOLLOWUP}</Markdown>);
  expect(container.textContent).toBe('核对购买链接');
  expect(screen.queryByRole('button')).toBeNull();
  const view = fixture(
    <TranscriptRenderContext.Provider value={{ isExporting: true }}>
      <Markdown>{`${CITATION}\n\n${FOLLOWUP}`}</Markdown>
    </TranscriptRenderContext.Provider>,
  );
  expect(view.container.textContent).not.toContain(':codex-');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

test('completed markers become controls as a reply streams, and stay usable after completion', () => {
  const view = fixture(<StreamingMarkdown content={FOLLOWUP.slice(0, -1)} isStreaming />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toBe(FOLLOWUP.slice(0, -1));
  view.rerenderContent(<StreamingMarkdown content={FOLLOWUP} isStreaming />);
  expect(screen.getByRole('button', { name: '核对购买链接' })).toBeTruthy();
  view.rerenderContent(<StreamingMarkdown content={FOLLOWUP} isStreaming={false} />);
  fireEvent.click(screen.getByRole('button', { name: '核对购买链接' }));
  expect(view.onFollowup).toHaveBeenCalledExactlyOnceWith(PROMPT);
});
