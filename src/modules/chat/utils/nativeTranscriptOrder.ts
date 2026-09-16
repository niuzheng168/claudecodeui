import type { NativeTranscriptPosition, NormalizedMessage } from '@/shared/types';
import { nativeTranscriptPositionOf as positionOf } from '@/shared/utils';

type OrderKey = { time: number; turn: string; item: number };

function turnKey(message: NormalizedMessage, position: NativeTranscriptPosition): string {
  return `${message.provider}\0${message.sessionId}\0${position.turnId}`;
}

/**
 * Used by the session store to merge native history with websocket replay.
 * Codex history timestamps every item at turn start, whereas live snapshots
 * carry arrival times. Those clocks cannot order items from the same turn.
 * Native positions are authoritative; transient echoes/notices stay next to
 * the native events they arrived between. Legacy providers retain clock order.
 */
export function orderNativeTranscriptMessages(
  messages: NormalizedMessage[],
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
  sortTime: (message: NormalizedMessage) => number,
): NormalizedMessage[] {
  // Legacy JSONL and SDK streams have no common native position contract.
  if (server.length > 0 && !server.some(positionOf)) return messages;
  if (!messages.some(positionOf)) return messages;

  const turnTimes = new Map<string, number>();
  const canonical = new Map<string, NormalizedMessage>();
  for (const message of [...server, ...realtime]) {
    const position = positionOf(message);
    if (!position) continue;
    const turn = turnKey(message, position);
    if (!turnTimes.has(turn)) turnTimes.set(turn, Date.parse(position.turnStartedAt));
    if (!canonical.has(message.id)) canonical.set(message.id, message);
  }
  const nativeKey = (message: NormalizedMessage): OrderKey | null => {
    const source = canonical.get(message.id) ?? message;
    const position = positionOf(source);
    if (!position) return null;
    const turn = turnKey(source, position);
    return { time: turnTimes.get(turn) ?? Date.parse(position.turnStartedAt), turn, item: position.itemIndex };
  };

  const keys = new Map<NormalizedMessage, OrderKey>();
  for (const message of messages) {
    const key = nativeKey(message);
    if (key) keys.set(message, key);
  }
  // Arrival order provides anchors for UI-only rows, not a second ordering
  // for native items. In particular, a late steer acknowledgement must not
  // put its user message after the assistant's already-streamed answer.
  let previous: OrderKey | null = null;
  for (const message of realtime) {
    const key = nativeKey(message);
    if (key) previous = key;
    else if (previous && !message.replacesAnchorId) {
      keys.set(message, { ...previous, item: previous.item + 0.5 });
    }
  }
  let next: OrderKey | null = null;
  for (let index = realtime.length - 1; index >= 0; index--) {
    const message = realtime[index];
    const key = nativeKey(message);
    if (key) next = key;
    else if (next && !keys.has(message) && !message.replacesAnchorId
      && sortTime(message) >= next.time) {
      keys.set(message, { ...next, item: next.item - 0.5 });
    }
  }
  const keyFor = (message: NormalizedMessage): OrderKey =>
    keys.get(message) ?? { time: sortTime(message), turn: '', item: 0 };
  return [...messages].sort((left, right) => {
    const a = keyFor(left), b = keyFor(right);
    return a.time - b.time || a.turn.localeCompare(b.turn) || a.item - b.item;
  });
}
