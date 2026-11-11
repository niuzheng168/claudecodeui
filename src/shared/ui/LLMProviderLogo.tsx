import type { LLMProvider } from '@/shared/types';
import ClaudeLogo from '@/shared/ui/ClaudeLogo';
import CodexLogo from '@/shared/ui/CodexLogo';
import CursorLogo from '@/shared/ui/CursorLogo';
import OpenCodeLogo from '@/shared/ui/OpenCodeLogo';

type LLMProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

/** Used by the chat, onboarding, project-workspace, settings and sidebar modules to show which coding agent a session or project belongs to. */
export function LLMProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: LLMProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }
  if (provider === 'antigravity') {
    // Reuse Workbench's existing Gemini mark, not a second Google icon system.
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <path fill="#6f9cf7" d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5Z" />
      </svg>
    );
  }

  return <ClaudeLogo className={className} />;
}
