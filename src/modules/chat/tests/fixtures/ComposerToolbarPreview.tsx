// Local visual-test entry only: no backend, microphone, model request or persisted user settings.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import '@/index.css';
import { ComposerToolbar } from '@/modules/chat/composer/ComposerToolbar';
import { ComposerVoiceControl } from '@/modules/chat/composer/ComposerVoiceControl';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea } from '@/modules/chat/composer/PromptInput';
import type { CodeyVoiceConfig, CodeyVoicePreferences, PermissionMode, VoiceInputState } from '@/shared/types';

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
};
const voiceModes: VoiceInputState[] = ['idle', 'requesting', 'recording', 'transcribing'];

function ComposerToolbarPreview() {
  // The preview draft is local to this disposable browser context.
  const [input, setInput] = useState(params.get('draft') || '');
  // These states exercise presentation only; no MediaRecorder or getUserMedia exists in this fixture.
  const [voiceState, setVoiceState] = useState<VoiceInputState>(voiceModes.find((value) => value === params.get('state')) || 'idle');
  // Selectors update this in-memory fixture, not a real user's saved provider.
  const [preferences, setPreferences] = useState<CodeyVoicePreferences>({ provider: 'azure-speech', language: 'auto' });
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
            voiceControl={<ComposerVoiceControl state={voiceState} disabled={false}
              onToggle={() => { record('mic'); setVoiceState((value) => value === 'idle' ? 'recording' : 'idle'); }}
              onCancel={() => { record('cancel-voice'); setVoiceState('idle'); }}
              managed={{ config, preferences, onChange: (patch) => setPreferences((value) => ({ ...value, ...patch })),
                onRefresh: () => record('refresh-voice'), loadFailed: false }} />}
            modelControl={<ComposerModelMenu effort={effort} effortOptions={['low', 'medium', 'high', 'max'].map((value) => ({ value }))}
              onSelectEffort={(value) => { setEffort(value); record(`effort:${value}`); }}
              model="gpt-6-astra" modelOptions={[{ value: 'gpt-6-astra', label: modelLabel }]}
              onSelectModel={(value) => record(`model:${value}`)} modelsLoading={false} />}
            permissionControl={<ComposerPermissionMenu permissionMode={permission} permissionModes={['default', 'plan', 'acceptEdits', 'bypassPermissions']}
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
