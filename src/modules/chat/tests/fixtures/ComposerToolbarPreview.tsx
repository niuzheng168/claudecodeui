// Local visual-test entry only: no backend, microphone, model request or persisted user settings.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ChevronDown } from 'lucide-react';

import '@/index.css';
import { ComposerToolbar } from '@/modules/chat/composer/ComposerToolbar';
import { ComposerCompletionControl } from '@/modules/chat/composer/ComposerCompletionControl';
import { ComposerVoiceControl } from '@/modules/chat/composer/ComposerVoiceControl';
import { VoiceRewriteControl } from '@/modules/chat/composer/VoiceRewriteControl';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea } from '@/modules/chat/composer/PromptInput';
import type { CodeyVoiceConfig, CodeyVoicePreferences, ComposerPreferences, PermissionMode, VoiceInputState } from '@/shared/types';

const params = new URLSearchParams(window.location.search);
const locale = params.get('locale') || 'zh-CN';
const translations = createInstance();
await translations.init({
  lng: locale, fallbackLng: 'en', defaultNS: 'chat',
  resources: JSON.parse(document.getElementById('preview-messages')?.textContent || '{}'),
  interpolation: { escapeValue: false },
});
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
document.documentElement.lang = locale;

const config: CodeyVoiceConfig = {
  userId: 'visual-test-only', maxDurationSeconds: 120, defaultProvider: 'azure-speech',
  languages: ['auto', 'zh-CN', 'en-US'],
  providers: [
    { id: 'azure-speech', label: 'Azure Speech', configured: true },
    { id: 'mai-transcribe', label: 'MAI Transcribe', configured: true },
  ],
  rewrite: { configured: true },
};
const voiceModes: VoiceInputState[] = ['idle', 'requesting', 'recording', 'transcribing'];

function ComposerToolbarPreview() {
  // The preview draft is local to this disposable browser context.
  const [input, setInput] = useState(params.get('draft') || '');
  // The preview simulates only presentation/undo, never a real rewrite request.
  const [rewriteBusy, setRewriteBusy] = useState(params.get('rewrite') === 'busy');
  // Retain both versions to exercise local undo/restore and the regeneration menu visually.
  const [rewriteSnapshot, setRewriteSnapshot] = useState<{ original: string; rewritten: string } | null>(
    params.get('rewrite') === 'done' ? { original: '原始语音文字', rewritten: input } : null,
  );
  // These states exercise presentation only; no MediaRecorder or getUserMedia exists in this fixture.
  const [voiceState, setVoiceState] = useState<VoiceInputState>(voiceModes.find((value) => value === params.get('state')) || 'idle');
  // Selectors update this in-memory fixture, not a real user's saved provider.
  const [preferences, setPreferences] = useState<CodeyVoicePreferences>({ provider: 'azure-speech', language: 'auto' });
  // Completion consent is simulated locally; this fixture never requests suggestions.
  const [completionPreferences, setCompletionPreferences] = useState<ComposerPreferences>({
    completionEnabled: params.get('completion') !== 'off', useHistory: true,
  });
  // Menus may change a fake next-turn preference without contacting a model.
  const [effort, setEffort] = useState('max');
  // Test permission appearance without modifying real approval policies.
  const [permission, setPermission] = useState<PermissionMode>('default');
  // Visible action evidence lets the headless test distinguish browsing menus from sending a message.
  const [actions, setActions] = useState<string[]>([]);
  const record = (action: string) => setActions((items) => [...items, action]);
  const modelLabel = params.get('long') === '1'
    ? 'An intentionally very long custom Codex deployment name (872K context)'
    : 'GPT-6 Astra (872K context)';
  const rewriteAllowed = !rewriteBusy && voiceState === 'idle' && Boolean(input.trim()) &&
    (!rewriteSnapshot || [rewriteSnapshot.original, rewriteSnapshot.rewritten].includes(input));

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
      <header style={{ padding: '18px 24px', fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>
        Codey · {locale === 'zh-CN' ? '输入工具栏预览 · 不连接节点' : 'Composer preview · no node connection'}
      </header>
      <div style={{ flex: 1, minHeight: 0 }} />
      <div className="chat-composer-shell" style={{ width: '100%', maxWidth: 880, margin: '0 auto', padding: '0 8px 20px' }}>
        <PromptInput onSubmit={(event) => { event.preventDefault(); record('send'); }}>
          <PromptInputBody>
            <PromptInputTextarea rows={2} aria-label="Draft" value={input} onChange={(event) => setInput(event.target.value)}
              placeholder={locale === 'zh-CN' ? '输入消息，或输入 / 使用命令…' : 'Message Codex, or type / for commands…'} />
          </PromptInputBody>
          <ComposerToolbar onAttachFiles={() => record('attach')}
            collapseControl={<button type="button" onClick={() => record('collapse')}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground md:hidden">
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              {translations.t('composer.collapseInput')}
            </button>}
            completionControl={<ComposerCompletionControl configured ready preferences={completionPreferences}
              onPreferenceChange={(patch) => setCompletionPreferences((value) => ({ ...value, ...patch }))} />}
            voiceControl={<ComposerVoiceControl state={voiceState} disabled={false}
              onToggle={() => {
                record('mic');
                if (voiceState === 'idle') setRewriteSnapshot(null);
                setVoiceState((value) => value === 'idle' ? 'recording' : 'idle');
              }}
              onCancel={() => { record('cancel-voice'); setVoiceState('idle'); }}
              managed={{ config, preferences, onChange: (patch) => setPreferences((value) => ({ ...value, ...patch })),
                onRefresh: () => record('refresh-voice'), loadFailed: false }} />}
            rewriteControl={<VoiceRewriteControl busy={rewriteBusy} canRewrite={rewriteAllowed}
              canUndo={Boolean(rewriteAllowed && rewriteSnapshot && input === rewriteSnapshot.rewritten && input !== rewriteSnapshot.original)}
              canRestore={Boolean(rewriteAllowed && rewriteSnapshot && input === rewriteSnapshot.original && input !== rewriteSnapshot.rewritten)}
              hasPreviousRewrite={rewriteSnapshot !== null} configured
              originalText={rewriteSnapshot?.original}
              notice={rewriteSnapshot ? ![rewriteSnapshot.original, rewriteSnapshot.rewritten].includes(input)
                ? 'draftChanged' : input === rewriteSnapshot.original ? 'undone' : 'done' : undefined}
              onRewrite={() => {
                record('rewrite');
                const rewritten = locale === 'zh-CN' ? '请检查 westus2 的语音配置，不要重启服务。' : 'Check the voice settings without restarting.';
                setRewriteSnapshot({ original: rewriteSnapshot?.original ?? input, rewritten });
                setInput(rewritten);
              }}
              onCancel={() => { record('cancel-rewrite'); setRewriteBusy(false); }}
              onUndo={() => { if (rewriteSnapshot) { record('undo-rewrite'); setInput(rewriteSnapshot.original); } }}
              onRestore={() => { if (rewriteSnapshot) { record('restore-rewrite'); setInput(rewriteSnapshot.rewritten); } }} />}
            modelControl={<ComposerModelMenu effort={effort} effortOptions={params.get('model') === 'none' ? [] : ['low', 'medium', 'high', 'max'].map((value) => ({ value }))}
              onSelectEffort={(value) => { setEffort(value); record(`effort:${value}`); }}
              model="gpt-6-astra" modelOptions={params.get('model') === 'none' ? [] : [{ value: 'gpt-6-astra', label: modelLabel }]}
              onSelectModel={(value) => record(`model:${value}`)} modelsLoading={false} />}
            permissionControl={<ComposerPermissionMenu permissionMode={permission} permissionModes={params.get('permissions') === 'none' ? [] : ['default', 'plan', 'acceptEdits', 'bypassPermissions']}
              providerLabel="Codex" onSelectPermissionMode={(value) => { setPermission(value); record(`permission:${value}`); }} />}
            submitControl={<PromptInputSubmit aria-label={locale === 'zh-CN' ? '发送' : 'Send'}
              disabled={!input.trim()} className="h-9 w-9" />}
            tokenUsage={{ used: Number(params.get('tokens') || 0) }} onShowTokenUsage={() => record('tokens')}
            commandsCount={12} onShowCommands={() => record('commands')}
            hasInput={Boolean(input.trim())} onClearInput={() => { setInput(''); record('clear'); }}
            canSchedule={Boolean(input.trim())} onSchedule={(date) => record(`schedule:${date.toISOString()}`)}
            submitHint={translations.t('input.hintText.enter')} hideHint={false}
            voiceStatus={voiceState === 'idle' ? undefined : translations.t(`voice.${voiceState}`)}
            voiceError={params.get('error') || null} />
        </PromptInput>
      </div>
      <output data-testid="preview-actions" style={{ display: 'none' }}>{JSON.stringify(actions)}</output>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Preview root is missing');
createRoot(root).render(
  <I18nextProvider i18n={translations}><ComposerToolbarPreview /></I18nextProvider>,
);
