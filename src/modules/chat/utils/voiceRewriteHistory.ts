import type { ChatMessage, VoiceRewriteMessage } from '@/shared/types';
import { selectComposerHistory } from '@/shared/utils';

/** Chat rewrite retains its original three-turn/3000-byte budget independently of completion configuration. */
export function selectVoiceRewriteHistory(messages: ChatMessage[]): VoiceRewriteMessage[] {
  return selectComposerHistory(messages, { messages: 6, bytes: 3000, messageBytes: 1000 });
}
