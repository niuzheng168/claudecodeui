import { createContext } from 'react';

/**
 * MessageComponent scopes local Markdown images (including nested tool results)
 * to this transcript's project, rather than a browser URL or a global asset name.
 */
export const TranscriptProjectContext = createContext<string | null>(null);
