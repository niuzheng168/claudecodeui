import { useCallback, useMemo } from 'react';

import type { ChatMessage, ClaudePermissionSuggestion, DiffLine, LLMProvider, PermissionGrantResult, Project } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import type { LazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

type TranscriptRowsProps = {
  /** The rows to draw, oldest first; tool runs are grouped here. */
  messages: ChatMessage[];
  /** The scroll container's lazy-row observer; null keeps every row mounted. */
  lazyRows: LazyRowObserver | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
};

/**
 * Keys for the rows inside a collapsed tool group. They only have to be unique
 * among that group's own rows (ToolGroupContainer disambiguates repeats), so
 * they do not depend on the per-render key map — and being a module function,
 * the prop keeps its identity, which is what lets memo(ToolGroupContainer)
 * skip a group on a stream tick that did not touch it.
 */
const getGroupedMessageKey = (message: ChatMessage): string =>
  getIntrinsicMessageKey(message) ?? 'message-generated';

/**
 * The transcript's rows: consecutive tool calls folded into groups, each row
 * mounted lazily as it nears the viewport. Rendered by chat's ChatMessagesPane,
 * and by the shared-session module (through the chat barrel) so a session
 * shared with another user reads exactly like the owner's own chat.
 */
export default function TranscriptRows({
  messages,
  lazyRows,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
  onEditMessage,
  onForkFromMessage,
}: TranscriptRowsProps) {
  const groupedMessages = useMemo(
    () => groupConsecutiveTools(messages, Boolean(showThinking)),
    [messages, showThinking],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // The message drawn just before each row, which decides whether the row
  // continues a run by the same author: a group counts as its last message.
  const previousMessages = useMemo(() => groupedMessages.reduce<Array<ChatMessage | null>>((list, _item, index) => {
    if (index === 0) {
      return [null];
    }
    const before = groupedMessages[index - 1];
    const lastDrawn = isToolGroupItem(before) ? before.messages[before.messages.length - 1] : before;
    list.push(lastDrawn || list[index - 1]);
    return list;
  }, []), [groupedMessages]);

  const rowCount = groupedMessages.length;

  return (
    <>
      {groupedMessages.map((item, index) => {
        // Rows near the tail mount their content on first commit so the
        // initial scroll-to-bottom measures real heights; older rows
        // start as placeholders and mount when scrolled toward.
        const initiallyNearViewport = index >= rowCount - INITIAL_MOUNTED_TAIL_ROWS;
        const prevMessage = previousMessages[index];

        if (isToolGroupItem(item)) {
          return (
            <LazyMessageRow
              key={`tool-group-${getMessageKey(item.messages[0])}`}
              lazyRows={lazyRows}
              timestamp={item.timestamp}
              messageId={item.messages[0]?.sourceId}
              initiallyNearViewport={initiallyNearViewport}
            >
              <ToolGroupContainer
                group={item}
                prevMessage={prevMessage}
                createDiff={createDiff}
                getMessageKey={getGroupedMessageKey}
                onFileOpen={onFileOpen}
                onShowSettings={onShowSettings}
                onGrantToolPermission={onGrantToolPermission}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                selectedProject={selectedProject}
                provider={provider}
                onForkFromMessage={onForkFromMessage}
              />
            </LazyMessageRow>
          );
        }

        return (
          <LazyMessageRow
            key={getMessageKey(item)}
            lazyRows={lazyRows}
            timestamp={item.timestamp}
            messageId={item.sourceId}
            initiallyNearViewport={initiallyNearViewport}
          >
            <MessageComponent
              message={item}
              prevMessage={prevMessage}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={onGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              provider={provider}
              onEditMessage={onEditMessage}
              onForkFromMessage={onForkFromMessage}
            />
          </LazyMessageRow>
        );
      })}
    </>
  );
}
