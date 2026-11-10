import React from 'react';
import ReactDOM from 'react-dom/client';

import { i18n } from '@/modules/i18n';
import { readUserPreference } from '@/shared/userSettings';
import SharedSessionApp from '@/modules/shared-session/SharedSessionApp';

/**
 * The reader has never picked a language on this page (preferences are kept
 * per page path, so their own workspace's choice does not carry over): follow
 * the browser, which for a Workbench user is what the Workbench speaks. Runs
 * before the first render; bundled translations switch synchronously.
 */
function applyBrowserLanguageByDefault() {
  if (readUserPreference<string | null>('userLanguage', null)) return;
  const supported = Object.keys(i18n.options.resources ?? {});
  const preferred = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  for (const candidate of preferred) {
    const exact = supported.find((language) => language.toLowerCase() === candidate.toLowerCase());
    const chinese = /^zh\b/i.test(candidate)
      ? (/^zh-(tw|hk|mo|hant)/i.test(candidate) ? 'zh-TW' : 'zh-CN')
      : null;
    const base = supported.find((language) => language.toLowerCase() === candidate.split('-')[0].toLowerCase());
    const language = exact ?? (chinese && supported.includes(chinese) ? chinese : base);
    if (language) {
      if (language !== i18n.language) {
        void i18n.changeLanguage(language);
      }
      return;
    }
  }
}

/**
 * Used by main.tsx when the Portal set `window.__CODEY_SHARED_SESSION__`: it
 * renders the shared-session page instead of the app, with no service worker
 * and no router.
 */
export function mountSharedSessionPage(rootElement: HTMLElement, runtime: unknown): void {
  applyBrowserLanguageByDefault();
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <SharedSessionApp runtime={runtime} />
    </React.StrictMode>,
  );
}
