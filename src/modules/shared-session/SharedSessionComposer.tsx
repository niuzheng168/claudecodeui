import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/modules/chat';

/** The Portal refuses a message longer than this (codey `MAX_TEXT_CHARS`). */
const MAX_MESSAGE_CHARS = 32000;
/** The composer grows with its text up to this height, then scrolls. */
const MAX_TEXTAREA_HEIGHT_PX = 240;

type SharedSessionComposerProps = {
  /** Sends one message; resolves true once the Portal accepted it, which clears the box. */
  onSend: (text: string) => Promise<boolean>;
  disabled?: boolean;
  placeholder: string;
  /** Ctrl/Cmd+Enter sends and Enter starts a new line, as the reader chose for their own chat. */
  sendByCtrlEnter?: boolean;
};

/**
 * The shared-session page's text-only composer: no attachments, commands,
 * models or permission modes, since all of those belong to the owner's
 * machine. A message goes to the owner's session through the Portal.
 */
export default function SharedSessionComposer({ onSend, disabled = false, placeholder, sendByCtrlEnter = false }: SharedSessionComposerProps) {
  const { t } = useTranslation('chat');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The message being written; kept when a send fails so nothing is lost.
  const [text, setText] = useState('');
  // A send is in flight: the button waits and a second Enter does not send twice.
  const [isSending, setIsSending] = useState(false);

  // Grow the box with its content.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [text]);

  const canSend = !disabled && !isSending && text.trim().length > 0;

  const send = useCallback(async () => {
    const message = text.trim();
    if (!message || disabled || isSending) return;
    setIsSending(true);
    try {
      if (await onSend(message)) {
        // Whatever was typed while the send was in flight stays.
        setText((current) => (current.trim() === message ? '' : current));
      }
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [disabled, isSending, onSend, text]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an input method is composing picks a candidate, not a send.
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.shiftKey) return;
    const modified = event.ctrlKey || event.metaKey;
    if (sendByCtrlEnter ? modified : !modified) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <PromptInput onSubmit={handleSubmit} status="ready">
      <PromptInputBody>
        <PromptInputTextarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          maxLength={MAX_MESSAGE_CHARS}
          disabled={disabled}
          rows={2}
          aria-label={placeholder}
          className="pt-3"
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools />
        <PromptInputSubmit
          disabled={!canSend}
          aria-label={t('sharedSession.composer.send', { defaultValue: 'Send' })}
          title={t('sharedSession.composer.send', { defaultValue: 'Send' })}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}
