import { escapeHtml } from '../mail/format.js';
import { renderMenu, type CallbackDeps } from './callbacks.js';
import type { CommandDeps } from './commands.js';
import type { Conversations } from './conversation.js';
import type { InlineKeyboard } from './sender.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';

/**
 * The slice of TelegramSender these adapters need, so a test can supply a
 * stub without a live bot token.
 */
export type TelegramSurface = {
  send: (html: string, keyboard?: InlineKeyboard) => Promise<unknown>;
  editMessageText: (
    chatId: string,
    messageId: number,
    html: string,
    keyboard?: InlineKeyboard
  ) => Promise<boolean>;
  deleteMessage: (chatId: string, messageId: number) => Promise<boolean>;
  answerCallbackQuery: (callbackQueryId: string) => Promise<boolean>;
};

export type TelegramDepsOptions = {
  sender: TelegramSurface;
  /** Already trimmed by the caller: see main() for why. */
  operatorChatId: string;
  mailboxes: MailboxStore;
  seen: Pick<SeenStore, 'purgeAccount'>;
  registry: WatcherRegistry;
  conversations: Conversations;
  probe: (account: Account) => Promise<ProbeResult>;
  now?: () => number;
};

export type TelegramDeps = {
  callbackDeps: CallbackDeps;
  commandDeps: CommandDeps;
};

/**
 * Wires the two inbound handlers to a sender.
 *
 * Exported rather than inlined into main() because the two adapters below
 * differ in exactly one respect — whether they escape — and getting that
 * backwards is a total-loss, completely silent failure: escaping the
 * callback side renders every button message as literal "&lt;b&gt;", and
 * dropping the keyboard argument or the `menu` wiring removes the feature's
 * only discoverable entry point. Inside a closure in main(), none of that
 * was reachable by any test.
 */
export function buildTelegramDeps(opts: TelegramDepsOptions): TelegramDeps {
  const { sender, operatorChatId } = opts;
  const now = opts.now ?? (() => Date.now());

  // The callback deps take ALREADY-ESCAPED HTML — callbacks.ts escapes each
  // interpolated field itself, because (unlike commands.ts) it emits
  // intentional <b> markup. Escaping the whole string again here would show
  // the operator literal "&amp;lt;"-style double-escaped markup.
  const callbackDeps: CallbackDeps = {
    operatorChatId,
    mailboxes: opts.mailboxes,
    seen: opts.seen,
    registry: opts.registry,
    conversations: opts.conversations,
    probe: opts.probe,
    answer: (id) => sender.answerCallbackQuery(id),
    edit: (messageId, html, keyboard) =>
      sender.editMessageText(operatorChatId, messageId, html, keyboard),
    reply: async (html, keyboard) => {
      await sender.send(html, keyboard);
    },
    now,
  };

  const commandDeps: CommandDeps = {
    operatorChatId,
    mailboxes: opts.mailboxes,
    seen: opts.seen,
    registry: opts.registry,
    conversations: opts.conversations,
    probe: opts.probe,
    reply: async (text: string, keyboard?: InlineKeyboard) => {
      // commands.ts deliberately emits no markup, but TelegramSender always
      // sends with parse_mode: 'HTML' — a label or hostname containing '<'
      // or '&' would otherwise produce a Telegram 400. The keyboard argument
      // must be forwarded, not dropped, or the add wizard's host quick-picks
      // (which flow through this same reply) would never render.
      await sender.send(escapeHtml(text), keyboard);
    },
    deleteMessage: (messageId: number) => sender.deleteMessage(operatorChatId, messageId),
    now,
    // /start, /help and /menu render the button menu. This is the only
    // discoverable entry point into the button UI; without it the feature
    // exists but nothing leads to it.
    menu: () => renderMenu(callbackDeps),
  };

  return { callbackDeps, commandDeps };
}
