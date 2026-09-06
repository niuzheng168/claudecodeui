import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2, X } from 'lucide-react';

import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import type { VoiceInputState } from '@/shared/types';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  contextLabel?: string;
  disabled?: boolean;
  onCancel?: () => void;
};

// Rendered by chat's ComposerVoiceControl; errors appear in the full-width toolbar status area.
// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
export default function VoiceInputButton({ state, onToggle, contextLabel, disabled = false, onCancel }: Props) {
  const { t } = useTranslation('chat');

  const icon =
    state === 'recording' ? (
      <Square className="text-red-500" />
    ) : state === 'transcribing' || state === 'requesting' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  const label = state === 'recording' ? t('voice.stopRecording') : state !== 'idle' ? t('voice.cancel') : t('voice.input');
  const accessibleLabel = contextLabel ? `${label} · ${contextLabel}` : label;
  return (
    <span className="relative inline-flex shrink-0">
      <PromptInputButton
        tooltip={{ content: accessibleLabel }}
        aria-label={accessibleLabel}
        className={state === 'recording' ? 'bg-red-500/10 hover:bg-red-500/15' : 'text-muted-foreground'}
        disabled={disabled && state === 'idle'}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          onToggle();
        }}
      >
        {icon}
      </PromptInputButton>
      {state === 'recording' && onCancel && (
        <PromptInputButton aria-label={t('voice.cancel')} tooltip={{ content: t('voice.cancel') }} onClick={onCancel}>
          <X />
        </PromptInputButton>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'requesting' ? t('voice.requesting') : state === 'recording' ? t('voice.recording') : state === 'transcribing' ? t('voice.transcribing') : ''}
      </span>
    </span>
  );
}
