import { I18nextProvider, useTranslation } from 'react-i18next';

import { i18n } from '@/modules/i18n';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { LLMProvider, SharedSessionRuntime } from '@/shared/types';
import SharedSessionPage from '@/modules/shared-session/SharedSessionPage';

const KNOWN_PROVIDERS = new Set<string>(['claude', 'cursor', 'codex', 'opencode', 'antigravity']);

/**
 * Validates the `window.__CODEY_SHARED_SESSION__` parameters the Portal
 * injects. The API root must be a same-origin absolute path: everything the
 * page writes goes there with the Portal login cookie.
 */
function readSharedSessionRuntime(value: unknown): SharedSessionRuntime | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const input = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === 'string' && field.trim() ? field.trim() : null);
  const grantId = text(input.grantId);
  const apiRoot = text(input.api);
  const sessionId = text(input.sessionId);
  const owner = text(input.owner);
  if (!grantId || !apiRoot || !apiRoot.startsWith('/') || apiRoot.startsWith('//') || !sessionId || !owner) {
    return null;
  }
  const provider = text(input.provider);
  return {
    grantId,
    api: apiRoot.replace(/\/+$/, ''),
    address: text(input.address),
    sessionId,
    provider: provider && KNOWN_PROVIDERS.has(provider) ? provider as LLMProvider : 'claude',
    title: text(input.title),
    owner,
    viewer: text(input.viewer),
    mode: input.mode === 'auto' ? 'auto' : 'confirm',
    approvals: input.approvals === 'user' ? 'user' : 'owner',
    expiresAt: text(input.expiresAt),
  };
}

function InvalidSharedSession() {
  const { t } = useTranslation('chat');
  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground" role="alert">
      {t('sharedSession.invalid', { defaultValue: 'This page is missing its parameters. Open it again from the Workbench.' })}
    </div>
  );
}

/**
 * The whole page the Portal serves at `/shared-sessions/<grantId>/`, with only
 * the providers the transcript needs (translations, theme, UI preferences) —
 * no router, auth, websocket or workspace state. Mounted by
 * mountSharedSessionPage; the module's tests render it directly.
 */
export default function SharedSessionApp({ runtime }: { runtime: unknown }) {
  const sharedSession = readSharedSessionRuntime(runtime);

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UiPreferencesProvider>
          {sharedSession ? <SharedSessionPage runtime={sharedSession} /> : <InvalidSharedSession />}
        </UiPreferencesProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
