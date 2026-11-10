import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { TranscriptViewerContext } from '@/modules/chat/context/TranscriptViewerContext';
import { buildTranscriptMarkdown } from '@/modules/chat/export/buildTranscriptMarkdown';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

const SENDER = 'codey://n-fedcba9876543210fedcba98/sender-session';

// The exact shape the node's session-message delivery writes: the envelope,
// the body on its own lines, then a note to the agent after the closing tag.
const envelope = (attributes: string, body: string, note = 'This came from alice, another Codey user, not from your user.') =>
  `<codey-session-message ${attributes}>\n${body}\n</codey-session-message>\n${note}`;

const userRow = (content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `row-${Math.random().toString(36).slice(2)}`,
  sessionId: 'session-1',
  timestamp: '2026-11-10T08:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content,
  ...overrides,
});

const convertOne = (content: string): ChatMessage => {
  const converted = normalizedToChatMessages([userRow(content)]);
  assert.equal(converted.length, 1);
  return converted[0];
};

describe('a <codey-session-message> envelope on a user turn', () => {
  it('shows only the body and records who sent it', () => {
    const message = convertOne(envelope(`from="${SENDER}" user="alice" agent="Codex"`, 'Please review the parser change.'));

    assert.equal(message.type, 'user');
    assert.equal(message.content, 'Please review the parser change.');
    assert.deepEqual(message.sender, { address: SENDER, user: 'alice', machine: null, agent: 'Codex' });
  });

  it('names the machine for a message from another of the owner\'s sessions', () => {
    const message = convertOne(envelope(`from="${SENDER}" machine="build-box" agent="Claude"`, 'Done.', 'The agent in another Codey session sent this.'));

    assert.equal(message.content, 'Done.');
    assert.deepEqual(message.sender, { address: SENDER, user: null, machine: 'build-box', agent: 'Claude' });
  });

  it('keeps a multi-line body whole, including an escaped closing tag, and drops the note', () => {
    const body = 'First line\n\nDone? <\\/codey-session-message> ok\nlast line';
    const message = convertOne(envelope(`from="${SENDER}" user="alice"`, body));

    assert.equal(message.content, 'First line\n\nDone? </codey-session-message> ok\nlast line');
    assert.ok(!String(message.content).includes('another Codey user'), 'the note to the agent is not shown');
  });

  it('treats a sender with no address as the owner through the Codey API', () => {
    const message = convertOne(envelope('from="unknown"', 'Ping', 'Your user sent this through the Codey API.'));
    assert.deepEqual(message.sender, { address: null, user: null, machine: null, agent: null });
    assert.equal(message.content, 'Ping');
  });

  it('accepts leading whitespace before the envelope', () => {
    const message = convertOne(`\n  ${envelope(`from="${SENDER}" user="alice"`, 'Hi')}`);
    assert.equal(message.content, 'Hi');
    assert.equal(message.sender?.user, 'alice');
  });

  it('ignores an envelope that does not open the message', () => {
    const content = `Look at this:\n${envelope(`from="${SENDER}" user="alice"`, 'quoted')}`;
    const message = convertOne(content);
    assert.equal(message.content, content);
    assert.equal(message.sender, undefined);
  });

  it('leaves malformed envelopes as plain text', () => {
    const malformed = [
      // Never closed.
      `<codey-session-message from="${SENDER}" user="alice">\nHello`,
      // No `from`: not the node's envelope.
      '<codey-session-message user="alice">\nHello\n</codey-session-message>',
      // An attribute the node could not have written.
      `<codey-session-message from="${SENDER}" user=alice>\nHello\n</codey-session-message>`,
      // A different tag that merely starts the same way.
      `<codey-session-messages from="${SENDER}">\nHello\n</codey-session-messages>`,
    ];
    for (const content of malformed) {
      const message = convertOne(content);
      assert.equal(message.content, content, content);
      assert.equal(message.sender, undefined, content);
    }
  });

  it('does not touch assistant text that happens to contain an envelope', () => {
    const content = envelope(`from="${SENDER}" user="alice"`, 'Hi');
    const [message] = normalizedToChatMessages([userRow(content, { role: 'assistant' })]);
    assert.equal(message.type, 'assistant');
    assert.equal(message.sender, undefined);
    assert.ok(String(message.content).includes('<codey-session-message'));
  });

  it('names the sender in a Markdown export instead of "You"', () => {
    const markdown = buildTranscriptMarkdown({
      messages: [
        convertOne(envelope(`from="${SENDER}" user="alice"`, 'Please review.')),
        convertOne('My own question'),
      ],
      sessionTitle: 'Review',
      provider: 'claude',
      exportedAt: new Date('2026-11-10T08:00:00.000Z'),
      createDiff: () => [],
    });
    assert.ok(markdown.includes('### From alice\n\nPlease review.'));
    assert.ok(markdown.includes('### You\n\nMy own question'));
    assert.ok(!markdown.includes('codey-session-message'));
  });
});

const renderUserMessage = (message: ChatMessage, viewer: { ownerName: string; viewerName: string | null } | null = null) =>
  render(
    <UiPreferencesProvider>
      <TranscriptViewerContext.Provider value={viewer}>
        <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
      </TranscriptViewerContext.Provider>
    </UiPreferencesProvider>,
  );

describe('the sender badge above a user bubble', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says which user sent it', () => {
    renderUserMessage(convertOne(envelope(`from="${SENDER}" user="alice" agent="Codex"`, 'Please review.')));
    assert.equal(screen.getByTestId('message-sender').textContent, 'From alice');
    assert.equal(screen.getByTestId('message-sender').getAttribute('title'), `${SENDER} · Codex`);
    assert.ok(screen.getByText('Please review.'));
  });

  it('says which machine\'s session sent it', () => {
    renderUserMessage(convertOne(envelope(`from="${SENDER}" machine="build-box"`, 'Done.')));
    assert.equal(screen.getByTestId('message-sender').textContent, 'From a session on build-box');
  });

  it('is translated', async () => {
    await i18n.changeLanguage('zh-CN');
    renderUserMessage(convertOne(envelope(`from="${SENDER}" user="alice"`, '看一下')));
    assert.equal(screen.getByTestId('message-sender').textContent, '来自 alice');
  });

  it('is absent for the owner\'s own message on the owner\'s page', () => {
    renderUserMessage(convertOne('My own question'));
    assert.equal(screen.queryByTestId('message-sender'), null);
  });

  it('names the owner, and the reader as "Me", on a shared session\'s page', () => {
    const viewer = { ownerName: 'bob', viewerName: 'alice' };
    const { unmount } = renderUserMessage(convertOne('The owner typed this'), viewer);
    assert.equal(screen.getByTestId('message-sender').textContent, 'bob');
    unmount();

    renderUserMessage(convertOne(envelope(`from="${SENDER}" user="alice"`, 'I sent this')), viewer);
    assert.equal(screen.getByTestId('message-sender').textContent, 'Me');
  });
});
