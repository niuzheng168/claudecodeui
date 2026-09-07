// Opt-in loopback preview entry. Uses the real composer, but never connects a chat agent or production node.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import '@/index.css';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { hydrateUserPreferences } from '@/shared/userSettings';
import { hydrateChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

const query = new URLSearchParams(window.location.search);
const locale = query.get('locale') === 'en' ? 'en' : 'zh-CN';
const realModel = JSON.parse(document.getElementById('preview-runtime')?.textContent || '{}').realModel === true;
const i18n = createInstance();
await i18n.init({
  lng: locale, fallbackLng: 'en', defaultNS: 'chat',
  resources: JSON.parse(document.getElementById('preview-messages')?.textContent || '{}'),
  interpolation: { escapeValue: false },
});
await hydrateUserPreferences();
await hydrateChatDrafts();
const project: Project = { projectId: 'preview-only', displayName: 'Local completion preview', fullPath: '/preview-only' };
const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const seed: Record<string, ChatMessage[]> = {
  'preview-a': [
    { type: 'user', content: '我想增加一个根据上下文补全输入的功能，请先讨论设计，不要部署生产。', timestamp: 0 },
    { type: 'assistant', content: '可以先讨论桌面 Tab 采纳和手机补全按钮，使用独立本地环境验证交互。', timestamp: 1 },
  ],
  'preview-b': [
    { type: 'user', content: 'We are reviewing the trade-offs of short inline suggestions.', timestamp: 0 },
    { type: 'assistant', content: 'Compare latency, privacy, and explicit acceptance. Do not run any tools.', timestamp: 1 },
  ],
};

function ComposerCompletionPreview() {
  // Independent test conversations demonstrate scope invalidation without loading real history.
  const [session, setSession] = useState('preview-a');
  const [messages, setMessages] = useState(seed);
  // Mode changes affect only this local preview; no tool/agent channel exists.
  const [mode, setMode] = useState<PermissionMode>('default');
  // Theme controls preview both appearances without changing a user's real preferences.
  const [dark, setDark] = useState(query.get('theme') === 'dark');
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  const addMessage = (message: ChatMessage) => setMessages((previous) => ({
    ...previous, [session]: [...previous[session], message].slice(-20),
  }));
  const composer = useChatComposerState({
    selectedProject: project, selectedSession: { id: session }, currentSessionId: session,
    provider: 'codex', permissionMode: mode,
    cyclePermissionMode: () => setMode((previous) => modes[(modes.indexOf(previous) + 1) % modes.length]),
    resolvePermissionModeForProvider: (_provider, requested) => requested as PermissionMode,
    currentProviderModel: 'local-preview-only', currentProviderEffort: 'default',
    isLoading: false, canAbortSession: false, tokenBudget: null, sendByCtrlEnter: false,
    sendMessage: () => {
      addMessage({ type: 'assistant', content: locale === 'en'
        ? 'Saved to local preview history only. No chat model, command, or node task was run.'
        : '仅记录到本地测试上下文，没有调用对话模型、执行命令或操作节点。', timestamp: Date.now() });
    },
    addMessage, scrollToBottom: () => {}, setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  });
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-4">
        <div>
          <h1 className="text-lg font-semibold">{locale === 'en' ? 'Codey · Local completion preview' : 'Codey · 输入补全本地试用'}</h1>
          <p className="text-xs text-muted-foreground">
            {realModel
              ? (locale === 'en' ? 'Real Foundry Luna · synthetic/local history · no production connections'
                : '真实 Foundry Luna · 独立测试上下文 · 不连接生产节点')
              : (locale === 'en' ? 'Mock suggestions · no model calls' : '模拟补全 · 不调用模型')}
          </p>
        </div>
        <button type="button" className="min-h-11 rounded border border-border px-3 text-sm" onClick={() => setDark(!dark)}>
          {dark ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-3 px-4 pb-4">
        <div className="flex flex-wrap gap-2">
          {Object.keys(seed).map((id) => <button type="button" key={id} onClick={() => setSession(id)}
            aria-pressed={session === id} className={`min-h-11 rounded-lg border px-3 text-sm ${session === id ? 'border-primary text-primary' : 'border-border'}`}>
            {id === 'preview-a' ? '会话 A · 中文' : 'Session B · English'}
          </button>)}
          <button type="button" className="min-h-11 rounded-lg border border-border px-3 text-sm"
            onClick={() => { setMessages((previous) => ({ ...previous, [session]: seed[session] })); composer.handleClearInput(); }}>
            {locale === 'en' ? 'Reset this test conversation' : '重置当前测试对话'}
          </button>
        </div>
        <p className="rounded-lg bg-muted/40 p-3 text-sm">
          {locale === 'en'
            ? 'Open Inline completion below and enable suggestions first. Try typing “Please explain”. Tab accepts, Esc dismisses, and Ctrl+Alt+M changes mode. Send only adds local context.'
            : '先展开输入框下方的“自动补全”并开启。可试着输入“请把上一段回答总结成”或“Please explain”。Tab 采纳，Esc 忽略，Ctrl+Alt+M 切模式；发送只追加本地测试上下文。'}
        </p>
        <div aria-label="Local test conversation" className="max-h-[35vh] space-y-3 overflow-y-auto rounded-xl border border-border p-3">
          {messages[session].map((message, index) => (
            <div key={`${session}-${index}`} className="text-sm">
              <span className="mr-2 font-medium">{message.type === 'user' ? 'User' : 'Assistant'}</span>
              <span className="whitespace-pre-wrap break-words text-muted-foreground">{String(message.content ?? '')}</span>
            </div>
          ))}
        </div>
        <details className="text-sm">
          <summary className="min-h-9 cursor-pointer">{locale === 'en' ? 'Edit the reference context' : '编辑测试上下文'}</summary>
          {['user', 'assistant'].map((role, index) => (
            <label className="mt-2 block" key={role}>
              {role}
              <textarea className="mt-1 block w-full rounded border border-border bg-background p-2" rows={2}
                value={String(messages[session][index]?.content ?? '')}
                onChange={(event) => {
                  const text = event.target.value;
                  setMessages((previous) => ({ ...previous, [session]: previous[session].map((message, i) =>
                    i === index ? { ...message, content: text } : message) }));
                }} />
            </label>
          ))}
        </details>
        <div className="mt-auto">
          <ChatComposer
            pendingPermissionRequests={[]} handlePermissionDecision={() => {}} handleGrantToolPermission={() => ({ success: false })}
            activity={null} isLoading={false} onAbortSession={() => {}}
            permissionMode={mode} availablePermissionModes={modes} onSelectPermissionMode={setMode} providerLabel="Codex"
            effort="default" availableEffortOptions={[]} onSelectEffort={() => {}}
            model="local-preview-only" availableModelOptions={[{ value: 'local-preview-only', label: 'Local preview · no chat agent' }]}
            onSelectModel={() => {}} modelsLoading={false} tokenBudget={null} onShowTokenUsage={() => {}}
            slashCommandsCount={composer.slashCommandsCount} onToggleCommandMenu={composer.handleToggleCommandMenu}
            hasInput={Boolean(composer.input.trim())} onClearInput={composer.handleClearInput} onSubmit={composer.handleSubmit}
            isDragActive={composer.isDragActive} queuedDraft={composer.queuedDraft}
            isEditingSentMessage={Boolean(composer.editingAnchorId)} onCancelEditMessage={composer.cancelEditMessage}
            scheduledMessages={[]} onScheduleMessage={() => {}} onCancelScheduledMessage={() => {}}
            onEditQueuedDraft={composer.editQueuedDraft} onDeleteQueuedDraft={composer.deleteQueuedDraft}
            attachedFiles={composer.attachedFiles}
            onRemoveAttachment={(index) => composer.setAttachedFiles((files) => files.filter((_file, i) => i !== index))}
            fileErrors={composer.fileErrors}
            showFileDropdown={composer.showFileDropdown} filteredFiles={composer.filteredFiles}
            selectedFileIndex={composer.selectedFileIndex} onSelectFile={composer.selectFile}
            filteredCommands={composer.filteredCommands} selectedCommandIndex={composer.selectedCommandIndex}
            onCommandSelect={composer.handleCommandSelect} onCloseCommandMenu={composer.resetCommandMenuState}
            isCommandMenuOpen={composer.showCommandMenu} frequentCommands={composer.frequentCommands}
            getRootProps={composer.getRootProps as (...args: unknown[]) => Record<string, unknown>}
            getInputProps={composer.getInputProps as (...args: unknown[]) => Record<string, unknown>}
            openAttachmentPicker={composer.openAttachmentPicker} inputHighlightRef={composer.inputHighlightRef}
            renderInputWithMentions={composer.renderInputWithMentions} textareaRef={composer.textareaRef} input={composer.input}
            onReplaceComposerDraft={composer.replaceComposerDraft}
            completionContextKey={session} completionHistory={messages[session]} voiceRecordingAllowed
            onInputChange={composer.handleInputChange} onTextareaClick={composer.handleTextareaClick}
            onTextareaKeyDown={composer.handleKeyDown} onTextareaPaste={composer.handlePaste}
            onTextareaScrollSync={composer.syncInputOverlayScroll} onTextareaInput={composer.handleTextareaInput}
            isInputFocused={composer.isInputFocused} onInputFocusChange={composer.handleInputFocusChange}
            placeholder={locale === 'en' ? 'Type a message to try Luna suggestions…' : '输入文字，试用 Luna 自动补全…'}
            isTextareaExpanded={composer.isTextareaExpanded} />
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
createRoot(root).render(
  <I18nextProvider i18n={i18n}><UiPreferencesProvider><ComposerCompletionPreview /></UiPreferencesProvider></I18nextProvider>,
);
