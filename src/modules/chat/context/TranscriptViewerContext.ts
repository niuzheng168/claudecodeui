import { createContext } from 'react';

/**
 * Whose conversation a transcript is, when the reader is not its owner.
 *
 * Provided by the shared-session page (through the chat barrel), where another
 * Codey user reads a session its owner shared with them. There a user turn
 * without a `<codey-session-message>` envelope is the owner's own and is
 * labelled with the owner's name, and the reader's own messages are labelled
 * as theirs. Null on the owner's own chat page, where an unwrapped turn needs
 * no label.
 */
export const TranscriptViewerContext = createContext<{ ownerName: string; viewerName: string | null } | null>(null);
