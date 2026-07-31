import { describe, it, expect, vi } from 'vitest';
import { buildTelegramDeps, type TelegramSurface } from '../src/telegram/deps.js';
import { handleUpdate } from '../src/telegram/commands.js';
import { handleCallback } from '../src/telegram/callbacks.js';
import { Conversations } from '../src/telegram/conversation.js';
import { hostPickKeyboard } from '../src/telegram/keyboards.js';
import type { InlineKeyboard } from '../src/telegram/sender.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
import type { Account } from '../src/types.js';

const OPERATOR = '42';

/**
 * These adapters used to live in closures inside main(), which no test can
 * import. Two silent, total-loss regressions were therefore invisible:
 * adding escapeHtml to the callback adapter "for safety" renders every
 * button message as literal &lt;b&gt;, and dropping `menu:` removes the only
 * discoverable entry point into the whole feature. Both left 394 tests
 * green.
 */
function harness() {
  const sent: [string, InlineKeyboard | undefined][] = [];
  const edited: [string, number, string, InlineKeyboard | undefined][] = [];
  const deletedFrom: [string, number][] = [];
  const answered: string[] = [];

  const sender: TelegramSurface = {
    send: async (html, keyboard) => { sent.push([html, keyboard]); return 'sent'; },
    editMessageText: async (chatId, messageId, html, keyboard) => {
      edited.push([chatId, messageId, html, keyboard]);
      return true;
    },
    deleteMessage: async (chatId, messageId) => { deletedFrom.push([chatId, messageId]); return true; },
    answerCallbackQuery: async (id) => { answered.push(id); return true; },
  };

  const stored = new Map<string, Account>();
  const built = buildTelegramDeps({
    sender,
    operatorChatId: OPERATOR,
    mailboxes: {
      add: (a: Account) => { stored.set(a.label, a); },
      list: () => [...stored.values()].map((a) => ({
        label: a.label, host: a.host, port: a.port, username: a.user,
      })),
      get: (l: string) => stored.get(l) ?? null,
      labels: () => [...stored.keys()],
      remove: (l: string) => stored.delete(l),
    } as never,
    seen: { purgeAccount: vi.fn(() => 0) },
    registry: {
      add: async () => {},
      remove: async () => false,
      has: () => false,
      states: () => [],
      size: () => 0,
    } as never,
    conversations: new Conversations(),
    probe: async () => ({ ok: true, folders: 3 }),
    now: () => 1_000_000,
  });

  return { ...built, sent, edited, deletedFrom, answered, stored };
}

const msg = (text: string): TelegramUpdate => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: Number(OPERATOR) }, text },
});

const tap = (data: string): TelegramUpdate => ({
  update_id: 1,
  callback_query: {
    id: 'cbq-1',
    from: { id: Number(OPERATOR) },
    data,
    message: { message_id: 9, chat: { id: Number(OPERATOR) } },
  },
});

describe('the callback adapter', () => {
  it('passes already-escaped HTML through byte-identically on edit', async () => {
    const { callbackDeps, edited } = harness();
    await handleCallback(tap('m'), callbackDeps);
    // callbacks.ts escapes each interpolated field itself because it emits
    // intentional <b> markup. Escaping again here would show the operator
    // literal "&lt;b&gt;Mailboxes&lt;/b&gt;".
    expect(edited.at(-1)?.[2]).toContain('<b>');
    expect(edited.at(-1)?.[2]).not.toContain('&lt;b&gt;');
  });

  it('passes already-escaped HTML through byte-identically on the reply fallback', async () => {
    const { callbackDeps, sent } = harness();
    await callbackDeps.reply('<b>Mailboxes</b> & more');
    expect(sent.at(-1)?.[0]).toBe('<b>Mailboxes</b> & more');
  });

  it('addresses edit, delete and answer at the operator chat', async () => {
    const { callbackDeps, edited, answered } = harness();
    await handleCallback(tap('m'), callbackDeps);
    expect(edited.at(-1)?.[0]).toBe(OPERATOR);
    expect(edited.at(-1)?.[1]).toBe(9);
    expect(answered).toEqual(['cbq-1']);
  });
});

describe('the command adapter', () => {
  it('escapes HTML, since commands.ts emits no markup but the sender always uses parse_mode HTML', async () => {
    const { commandDeps, sent } = harness();
    await commandDeps.reply('a < b & c');
    expect(sent.at(-1)?.[0]).toBe('a &lt; b &amp; c');
  });

  it('forwards the keyboard rather than dropping it', async () => {
    // The wizard's host quick-picks flow through this same reply. Dropping
    // the keyboard would leave the operator with no quick-picks at all and
    // no test would notice.
    const { commandDeps, sent } = harness();
    await commandDeps.reply('Which IMAP host?', hostPickKeyboard());
    expect(sent.at(-1)?.[1]).toEqual(hostPickKeyboard());
  });

  it('deletes the password message from the operator chat', async () => {
    const { commandDeps, deletedFrom } = harness();
    await commandDeps.deleteMessage(77);
    expect(deletedFrom).toEqual([[OPERATOR, 77]]);
  });
});

describe('/start wiring', () => {
  it('renders the button menu, the only discoverable entry point into the feature', async () => {
    const { commandDeps, sent } = harness();
    await handleUpdate(msg('/start'), commandDeps);
    const texts = sent.map((s) => s[0]);
    expect(texts.some((t) => /Mailboxes/.test(t))).toBe(true);
    // The menu is a keyboard, not just text — without it there is no way in.
    expect(sent.some((s) => s[1] !== undefined)).toBe(true);
  });

  it('renders the menu unescaped, not as literal markup', async () => {
    const { commandDeps, sent } = harness();
    await handleUpdate(msg('/menu'), commandDeps);
    const menuMessage = sent.find((s) => /Mailboxes/.test(s[0]));
    expect(menuMessage?.[0]).toContain('<b>');
    expect(menuMessage?.[0]).not.toContain('&lt;b&gt;');
  });

  it('still sends the typed-command usage alongside the menu', async () => {
    const { commandDeps, sent } = harness();
    await handleUpdate(msg('/help'), commandDeps);
    expect(sent.map((s) => s[0]).join('\n')).toMatch(/\/add/);
  });
});
