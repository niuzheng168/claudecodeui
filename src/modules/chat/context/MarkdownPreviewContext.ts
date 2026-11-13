import { createContext } from 'react';

/**
 * Marks the expanded chat preview: Markdown fences become documents, and their
 * preview buttons are hidden so a preview cannot open another nested dialog.
 */
export const MarkdownPreviewContext = createContext(false);
