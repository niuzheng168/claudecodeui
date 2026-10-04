import { createContext } from 'react';

/**
 * ChatInterface lets transcript suggestions append to this session's composer,
 * without a global event or implicitly submitting another provider turn.
 */
export const TranscriptFollowupContext = createContext<((prompt: string) => void) | null>(null);
