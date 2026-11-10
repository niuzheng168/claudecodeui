export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';

// The shared-session page shows a session another user shared with the reader
// using the chat's own transcript, approval and composer parts.
export { useRemoteSessionTranscript } from '@/modules/chat/hooks/useRemoteSessionTranscript';
export { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
export { default as TranscriptRows } from '@/modules/chat/transcript/TranscriptRows';
export { TranscriptViewerContext } from '@/modules/chat/context/TranscriptViewerContext';
export { default as PermissionContext } from '@/modules/chat/context/PermissionContext';
export { default as PermissionRequestsBanner } from '@/modules/chat/composer/PermissionRequestsBanner';
export { default as ActivityIndicator } from '@/modules/chat/composer/ActivityIndicator';
export {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/modules/chat/composer/PromptInput';
