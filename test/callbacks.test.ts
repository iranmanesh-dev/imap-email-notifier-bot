import { describe, it, expect, vi } from 'vitest';
import { handleCallback, type CallbackDeps } from '../src/telegram/callbacks.js';
import { handleUpdate, type CommandDeps } from '../src/telegram/commands.js';
import {
  CONFIRM_TTL_MS, Conversations, PASSWORD_TTL_MS,
} from '../src/telegram/conversation.js';
import { decodeAction, encodeAction, labelToken } from '../src/telegram/keyboards.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
import type { InlineKeyboard } from '../src/telegram/sender.js';
import type { Account } from '../src/types.js';

const OPERATOR = 42;
const NOW = 1_000_000;

function tap(data: string, chatId = OPERATOR, messageId = 5): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      from: { id: chatId },
      data,
      message: { message_id: messageId, chat: { id: chatId } },
    },
  };
}

function makeDeps(overrides: Partial<CallbackDeps> = {}) {
  const stored = new Map<string, Account>();
  const running = new Set<string>();
  const answers: string[] = [];
  const edits: string[] = [];
  const editKeyboards: (InlineKeyboard | undefined)[] = [];
  const replies: string[] = [];
  const replyKeyboards: (InlineKeyboard | undefined)[] = [];
  const probes: string[] = [];

  const deps: CallbackDeps = {
    operatorChatId: String(OPERATOR),
    mailboxes: {
      add: (a: Account) => { stored.set(a.label, a); },
      list: () => [...stored.values()].map((a) => ({
        label: a.label, host: a.host, port: a.port, username: a.user,
      })),
      get: (l: string) => stored.get(l) ?? null,
      labels: () => [...stored.keys()],
      remove: (l: string) => stored.delete(l),
    } as unknown as CallbackDeps['mailboxes'],
    seen: { purgeAccount: vi.fn(() => 2) },
    registry: {
      add: async (a: Account) => { running.add(a.label); },
      remove: async (l: string) => running.delete(l),
      has: (l: string) => running.has(l),
      states: () => [...running].map((l) => ({ label: l, state: 'ok' as const })),
      size: () => running.size,
    } as unknown as CallbackDeps['registry'],
    conversations: new Conversations(),
    probe: async (a: Account) => { probes.push(a.label); return { ok: true, folders: 4 }; },
    answer: async (id: string) => { answers.push(id); return true; },
    edit: async (_id: number, html: string, keyboard?: InlineKeyboard) => {
      edits.push(html);
      editKeyboards.push(keyboard);
      return true;
    },
    reply: async (html: string, keyboard?: InlineKeyboard) => {
      replies.push(html);
      replyKeyboards.push(keyboard);
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps, answers, edits, editKeyboards, replies, replyKeyboards, stored, running, probes };
}

function typed(text: string, messageId = 77): TelegramUpdate {
  return { update_id: 2, message: { message_id: messageId, chat: { id: OPERATOR }, text } };
}

/**
 * A CommandDeps sharing the SAME Conversations instance as a CallbackDeps.
 *
 * The two inbound surfaces are the only two writers of conversation state,
 * and the defect this covers lives exactly in the seam between them: what a
 * button tap leaves behind is read back by the TYPED handler. Nothing that
 * exercises only one surface can see it.
 */
function makeCommandDeps(deps: CallbackDeps) {
  const replies: string[] = [];
  const deleted: number[] = [];
  const probes: string[] = [];
  const commandDeps: CommandDeps = {
    operatorChatId: deps.operatorChatId,
    mailboxes: deps.mailboxes,
    seen: deps.seen,
    registry: deps.registry,
    conversations: deps.conversations,
    probe: async (a: Account) => { probes.push(a.label); return { ok: true, folders: 1 }; },
    reply: async (t: string) => { replies.push(t); },
    deleteMessage: async (id: number) => { deleted.push(id); return true; },
    now: () => NOW,
  };
  return { commandDeps, replies, deleted, probes };
}

/** Decodes every button in a keyboard, for asserting on actions rather than raw encoded strings. */
function actionsIn(keyboard: InlineKeyboard | undefined) {
  return (keyboard ?? []).flat().map((b) => decodeAction(b.callback_data));
}

describe('authorization', () => {
  it('ignores a callback from any other chat entirely', async () => {
    const { deps, answers, edits, replies } = makeDeps();
    await handleCallback(tap('m', 999), deps);
    expect(answers).toEqual([]);
    expect(edits).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('touches nothing for an unauthorized chat — no probe, no store write, no answer', async () => {
    const { deps, probes, stored, answers } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    const token = labelToken('Work');
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token }), 999), deps);
    expect(probes).toEqual([]);
    expect(stored.size).toBe(1);
    expect(stored.has('Work')).toBe(true);
    expect(answers).toEqual([]);
  });

  it('ignores an update with no callback_query', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback({ update_id: 1 }, deps);
    expect(answers).toEqual([]);
  });
});

describe('answering', () => {
  it('answers the callback query on a normal action', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback(tap('m'), deps);
    expect(answers).toEqual(['cbq-1']);
  });

  it('answers even when the action is unrecognised', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback(tap('zzz'), deps);
    expect(answers).toEqual(['cbq-1']);
  });

  it('answers even when the handler throws', async () => {
    const { deps, answers } = makeDeps({
      edit: async () => { throw new Error('boom'); },
      reply: async () => { throw new Error('boom'); },
    });
    await expect(handleCallback(tap('m'), deps)).resolves.toBeUndefined();
    expect(answers).toEqual(['cbq-1']);
  });
});

describe('menu, list and status', () => {
  it('renders the menu on a menu tap', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('m'), deps);
    expect(edits[0]).toMatch(/mailbox/i);
  });

  it('falls back to a reply when editing is refused', async () => {
    const { deps, replies } = makeDeps({ edit: async () => false });
    await handleCallback(tap('m'), deps);
    expect(replies).toHaveLength(1);
  });

  it('list reports emptiness', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('l'), deps);
    expect(edits[0]).toMatch(/no mailboxes/i);
  });

  it('list masks the password', async () => {
    // The fake `list()` mirrors MailboxSummary — it never exposes `pass` at
    // all, so a `not.toContain('hunter2')` assertion here would hold no
    // matter what showList() does with the data. The real guarantee is
    // structural (MailboxStore.list() never decrypts or returns a
    // password); what this test can actually exercise is that the display
    // uses an explicit masked placeholder rather than, say, silently
    // omitting the field.
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u@x', pass: 'hunter2', secure: true });
    await handleCallback(tap('l'), deps);
    expect(edits[0]).toContain('Work');
    expect(edits[0]).toContain('••••••••');
  });

  it('status reports idle when nothing is watched', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('s'), deps);
    expect(edits[0]).toMatch(/no mailboxes/i);
  });

  it('status lists a watched mailbox and its state', async () => {
    const { deps, edits } = makeDeps();
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('s'), deps);
    expect(edits[0]).toContain('Work');
    expect(edits[0]).toContain('ok');
  });

  // The button Status view read the registry only, while /status reconciles
  // it against the store. A mailbox skipped during the startup restore, or
  // one /add persisted before registry.add failed, was therefore invisible
  // in the view the README now points operators at first.

  it('status flags a saved mailbox that has no watcher running', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Ghosted', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleCallback(tap('s'), deps);

    expect(edits.at(-1)).toContain('Work');
    expect(edits.at(-1)).toContain('Ghosted');
    expect(edits.at(-1)).toMatch(/not being watched/i);
  });

  it('status does not claim nothing is watched when every saved mailbox is unwatched', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Ghosted', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleCallback(tap('s'), deps);

    expect(edits.at(-1)).toContain('Ghosted');
    expect(edits.at(-1)).toMatch(/not being watched/i);
    expect(edits.at(-1)).not.toMatch(/^No mailboxes are being watched/);
  });

  it('status carries the same recovery hint the typed command gives, escaped for HTML', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Ghosted', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('s'), deps);
    expect(edits.at(-1)).toMatch(/\/test/);
    // The hint embeds a literal "<label>" placeholder. Unescaped, Telegram
    // rejects the whole message as bad HTML and the operator sees nothing.
    expect(edits.at(-1)).toContain('&lt;label&gt;');
  });

  it('status reports a failure to read the saved mailbox list instead of under-reporting', async () => {
    const { deps, edits, replies } = makeDeps();
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    deps.mailboxes.labels = () => {
      throw new Error('database is locked');
    };

    await handleCallback(tap('s'), deps);

    expect(replies.some((r) => /database is locked/.test(r))).toBe(true);
    expect(edits.at(-1)).toContain('Work');
  });

  it('remove-pick with no mailboxes says so instead of showing an empty keyboard', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('rp'), deps);
    expect(edits[0]).toMatch(/no mailboxes/i);
  });

  it('remove-pick lists the mailboxes', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('rp'), deps);
    expect(edits[0]).toMatch(/which mailbox/i);
  });

  it('escapes HTML in a mailbox label', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'A<b>X', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('l'), deps);
    expect(edits[0]).toContain('&lt;b&gt;');
    expect(edits[0]).not.toContain('<b>X');
  });
});

describe('add wizard', () => {
  it('add starts the wizard and asks for a label', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('a'), deps);
    expect(edits[0]).toMatch(/label/i);
    expect(deps.conversations.size()).toBe(1);
  });

  it('cancel clears the pending wizard and returns to the menu', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('a'), deps);
    await handleCallback(tap('c'), deps);
    expect(deps.conversations.size()).toBe(0);
    expect(edits.at(-1)).toMatch(/mailbox/i);
  });

  it('a host quick-pick advances to the port step', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleCallback(tap(encodeAction({ kind: 'host', value: 'imap.hostinger.com' })), deps);
    expect(edits.at(-1)).toMatch(/port/i);
  });

  it('a port quick-pick advances to the username step', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'Work', host: 'h', expiresAt: NOW + 60_000 });
    await handleCallback(tap(encodeAction({ kind: 'port', value: 993 })), deps);
    expect(edits.at(-1)).toMatch(/username|email/i);
  });

  it('type-host asks the operator to type a host and keeps the wizard pending', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleCallback(tap('xh'), deps);
    expect(edits.at(-1)).toMatch(/host/i);
    expect(deps.conversations.size()).toBe(1);
  });

  it('type-port asks the operator to type a port and keeps the wizard pending', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'Work', host: 'h', expiresAt: NOW + 60_000 });
    await handleCallback(tap('xp'), deps);
    expect(edits.at(-1)).toMatch(/port/i);
    expect(deps.conversations.size()).toBe(1);
  });

  it('type-host while the PORT step is pending refuses to solicit a host, and keeps the port step', async () => {
    // The operator restarted the wizard, so wizard-host is pending, but an
    // older message still shows the port keyboard. Soliciting "the port"
    // there would have handleUpdate's wizard-host branch consume the number
    // as the HOST — building a mailbox with host '993'.
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'Work', host: 'h', expiresAt: NOW + 60_000 });
    await handleCallback(tap('xh'), deps);
    expect(edits.at(-1)).not.toMatch(/send the imap host/i);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    const restored = deps.conversations.take(OPERATOR, NOW);
    expect(restored).toMatchObject({ kind: 'wizard-port', label: 'Work', host: 'h' });
  });

  it('type-port while the HOST step is pending refuses to solicit a port, and keeps the host step', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleCallback(tap('xp'), deps);
    expect(edits.at(-1)).not.toMatch(/send the port/i);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    const restored = deps.conversations.take(OPERATOR, NOW);
    expect(restored).toMatchObject({ kind: 'wizard-host', label: 'Work' });
  });

  it('type-host with no wizard pending returns to the menu instead of inventing one', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('xh'), deps);
    expect(edits.at(-1)).not.toMatch(/send the imap host/i);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    expect(deps.conversations.size()).toBe(0);
  });

  it('type-port with no wizard pending returns to the menu instead of inventing one', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('xp'), deps);
    expect(edits.at(-1)).not.toMatch(/send the port/i);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    expect(deps.conversations.size()).toBe(0);
  });

  it('a host pick with no wizard pending returns to the menu instead of guessing', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap(encodeAction({ kind: 'host', value: 'imap.x.com' })), deps);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    expect(deps.conversations.size()).toBe(0);
  });

  it('a stray host quick-pick while a port step is pending restores the port step instead of destroying it', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'Work', host: 'h', expiresAt: NOW + 60_000 });
    await handleCallback(tap(encodeAction({ kind: 'host', value: 'imap.x.com' })), deps);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    // Merely asserting size() === 1 would also pass if the wrong kind had
    // been re-set. Taking it back out and checking its kind and fields
    // proves the operator's actual place in the flow survived the stray tap.
    expect(deps.conversations.size()).toBe(1);
    const restored = deps.conversations.take(OPERATOR, NOW);
    expect(restored?.kind).toBe('wizard-port');
    expect(restored).toMatchObject({ kind: 'wizard-port', label: 'Work', host: 'h' });
  });

  it('a stray port quick-pick while a host step is pending restores the host step instead of destroying it', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleCallback(tap(encodeAction({ kind: 'port', value: 993 })), deps);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    expect(deps.conversations.size()).toBe(1);
    const restored = deps.conversations.take(OPERATOR, NOW);
    expect(restored?.kind).toBe('wizard-host');
    expect(restored).toMatchObject({ kind: 'wizard-host', label: 'Work' });
  });
});

describe('a button tap arriving mid-flow', () => {
  it('cancels a pending password prompt with a notice AND really disarms it', async () => {
    const { deps, replies } = makeDeps();
    const { commandDeps, deleted, probes } = makeCommandDeps(deps);
    deps.conversations.set(OPERATOR, {
      kind: 'password', label: 'Work', host: 'imap.gmail.com', port: 993,
      username: 'me@gmail.com', expiresAt: NOW + PASSWORD_TTL_MS,
    });

    await handleCallback(tap('l'), deps);

    expect(replies.some((r) => /cancel/i.test(r) && /Work/.test(r))).toBe(true);

    // The assertion that actually matters. A test checking only the notice
    // would miss the point: the danger is that the pending entry survives,
    // so the operator's NEXT ordinary message is irreversibly deleted from
    // Telegram and transmitted as a password in a real IMAP LOGIN to
    // imap.gmail.com, landing in a third party's auth-failure logs.
    await handleUpdate(typed('just chatting'), commandDeps);
    expect(deleted).toEqual([]);
    expect(probes).toEqual([]);
    expect(deps.conversations.size()).toBe(0);
  });

  it('cancels a pending removal confirmation, so a later "yes" cannot delete the mailbox', async () => {
    const { deps, replies, stored } = makeDeps();
    const { commandDeps } = makeCommandDeps(deps);
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    deps.conversations.set(OPERATOR, {
      kind: 'remove-confirm', label: 'Work', expiresAt: NOW + CONFIRM_TTL_MS,
    });

    await handleCallback(tap('s'), deps);
    expect(replies.some((r) => /cancel/i.test(r) && /Work/.test(r))).toBe(true);

    await handleUpdate(typed('yes'), commandDeps);
    expect(stored.size).toBe(1);
    expect(deps.seen.purgeAccount).not.toHaveBeenCalled();
  });

  it('cancels on an unrecognised callback too, not just on known actions', async () => {
    const { deps, replies } = makeDeps();
    const { commandDeps, deleted, probes } = makeCommandDeps(deps);
    deps.conversations.set(OPERATOR, {
      kind: 'password', label: 'Work', host: 'h', port: 993,
      username: 'u', expiresAt: NOW + PASSWORD_TTL_MS,
    });

    await handleCallback(tap('zzz-not-an-action'), deps);

    expect(replies.some((r) => /cancel/i.test(r))).toBe(true);
    await handleUpdate(typed('just chatting'), commandDeps);
    expect(deleted).toEqual([]);
    expect(probes).toEqual([]);
  });

  it('uses the same notice wording the typed surface uses for the same interruption', async () => {
    // Two surfaces, one rule. If commands.ts's wording is ever reworded,
    // this fails rather than letting the two drift apart silently.
    const { deps, replies } = makeDeps();
    const { commandDeps, replies: typedReplies } = makeCommandDeps(deps);
    const pending = {
      kind: 'password' as const, label: 'Work', host: 'h', port: 993,
      username: 'u', expiresAt: NOW + PASSWORD_TTL_MS,
    };

    deps.conversations.set(OPERATOR, pending);
    await handleCallback(tap('l'), deps);

    deps.conversations.set(OPERATOR, pending);
    await handleUpdate(typed('/list'), commandDeps);

    expect(replies[0]).toBe(typedReplies[0]);
  });

  it('escapes the label in the notice, since the button surface emits HTML', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, {
      kind: 'remove-confirm', label: 'A<b>X', expiresAt: NOW + CONFIRM_TTL_MS,
    });
    await handleCallback(tap('l'), deps);
    expect(replies[0]).toContain('&lt;b&gt;');
    expect(replies[0]).not.toContain('<b>X');
  });

  it('says nothing when there was no pending flow to cancel', async () => {
    const { deps, replies } = makeDeps();
    await handleCallback(tap('l'), deps);
    expect(replies).toEqual([]);
  });

  it('leaves the pending flow alone for the actions that manage it themselves', async () => {
    // cancel clears deliberately; add deliberately restarts; the four wizard
    // quick-picks consume and advance (or restore) their own step. Sweeping
    // those into the shared rule would break the wizard it is protecting.
    for (const data of ['c', 'a', 'h:imap.x.com', 'p:993', 'xh', 'xp']) {
      const { deps, replies } = makeDeps();
      deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'W', expiresAt: NOW + 60_000 });
      await handleCallback(tap(data), deps);
      expect(replies.filter((r) => /cancelled the pending/i.test(r))).toEqual([]);
    }
  });
});

describe('a stale quick-pick tapped while a DANGEROUS flow is pending', () => {
  // The four quick-picks consume their own step, so they are exempt from the
  // blanket cancel-on-tap rule. On a kind mismatch they restore what they
  // found — right for a wizard-* step (the operator's flow is live and losing
  // their place would be worse), but for a `password` or `remove-confirm`
  // entry restoring reproduces the exact Critical this wave exists to close:
  // the operator is shown a menu while a password prompt stays armed.
  const QUICK_PICKS = ['h:imap.x.com', 'p:993', 'xh', 'xp'];

  for (const data of QUICK_PICKS) {
    it(`'${data}' cancels a pending password prompt instead of restoring it`, async () => {
      const { deps, replies } = makeDeps();
      const { commandDeps, deleted, probes } = makeCommandDeps(deps);
      deps.conversations.set(OPERATOR, {
        kind: 'password', label: 'Work', host: 'imap.gmail.com', port: 993,
        username: 'me@gmail.com', expiresAt: NOW + PASSWORD_TTL_MS,
      });

      await handleCallback(tap(data), deps);

      expect(replies.some((r) => /cancel/i.test(r) && /Work/.test(r))).toBe(true);

      // The assertion that proves the Critical is actually closed rather
      // than merely announced.
      await handleUpdate(typed('just chatting'), commandDeps);
      expect(deleted).toEqual([]);
      expect(probes).toEqual([]);
      expect(deps.conversations.size()).toBe(0);
    });

    it(`'${data}' cancels a pending removal confirmation instead of restoring it`, async () => {
      const { deps, replies, stored } = makeDeps();
      const { commandDeps } = makeCommandDeps(deps);
      deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
      deps.conversations.set(OPERATOR, {
        kind: 'remove-confirm', label: 'Work', expiresAt: NOW + CONFIRM_TTL_MS,
      });

      await handleCallback(tap(data), deps);
      expect(replies.some((r) => /cancel/i.test(r) && /Work/.test(r))).toBe(true);

      await handleUpdate(typed('yes'), commandDeps);
      expect(stored.size).toBe(1);
      expect(deps.seen.purgeAccount).not.toHaveBeenCalled();
    });
  }

  it('still RESTORES a mismatched wizard step, which is live and must not be lost', async () => {
    // The other half of the rule. A stale host tap mid-port-step keeps the
    // operator's place, and says nothing about cancelling anything.
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'Work', host: 'h', expiresAt: NOW + 60_000 });

    await handleCallback(tap('h:imap.x.com'), deps);

    expect(replies.filter((r) => /cancelled the pending/i.test(r))).toEqual([]);
    const restored = deps.conversations.take(OPERATOR, NOW);
    expect(restored).toMatchObject({ kind: 'wizard-port', label: 'Work', host: 'h' });
  });

  it('a stale type-port tap keeps a live host step rather than cancelling it', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });

    await handleCallback(tap('xp'), deps);

    expect(replies.filter((r) => /cancelled the pending/i.test(r))).toEqual([]);
    const restored = deps.conversations.take(OPERATOR, NOW);
    expect(restored).toMatchObject({ kind: 'wizard-host', label: 'Work' });
  });
});

describe('remove and test', () => {
  function seed(deps: CallbackDeps, label: string) {
    deps.mailboxes.add({ label, host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
  }

  it('picking a mailbox asks for confirmation and deletes nothing yet', async () => {
    const { deps, edits, editKeyboards, stored } = makeDeps();
    seed(deps, 'Work');
    const token = labelToken('Work');
    await handleCallback(tap(encodeAction({ kind: 'remove', token })), deps);
    expect(edits.at(-1)).toMatch(/remove/i);
    expect(stored.size).toBe(1);
    // The whole point of this screen is a real confirm button carrying the
    // SAME token — asserting on decoded actions rather than the raw html
    // means a keyboard that silently reverted to the menu (leaving the
    // operator no way to confirm) cannot pass by matching on text alone.
    expect(actionsIn(editKeyboards.at(-1))).toContainEqual({ kind: 'remove-confirm', token });
  });

  it('confirming removes the mailbox, stops the watcher and purges state', async () => {
    const { deps, stored, running, edits, editKeyboards } = makeDeps();
    seed(deps, 'Work');
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);

    expect(stored.size).toBe(0);
    expect(running.has('Work')).toBe(false);
    expect(deps.seen.purgeAccount).toHaveBeenCalledWith('Work');
    expect(edits.at(-1)).toMatch(/removed/i);
    expect(actionsIn(editKeyboards.at(-1))).toContainEqual({ kind: 'add' });
  });

  it('removing a mailbox that was never watched says so instead of overclaiming', async () => {
    const { deps, edits, running } = makeDeps();
    seed(deps, 'Work');
    // Deliberately not added to the registry.
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);
    expect(running.has('Work')).toBe(false);
    expect(edits.at(-1)).toMatch(/not being watched|nothing to stop/i);
  });

  it('a stale remove token reports the mailbox is gone and acts on nothing', async () => {
    const { deps, stored, edits } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Deleted') })), deps);
    expect(stored.size).toBe(1);
    expect(edits.at(-1)).toMatch(/no longer exists|not found/i);
  });

  it('a stale token never purges another account', async () => {
    const { deps } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Ghost') })), deps);
    expect(deps.seen.purgeAccount).not.toHaveBeenCalled();
  });

  it('a mailbox store failure removing credentials is reported, not silently swallowed', async () => {
    const { deps, edits } = makeDeps();
    seed(deps, 'Work');
    deps.mailboxes.remove = () => {
      throw new Error('database is locked');
    };
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);
    // The watcher IS stopped by this point (registry.remove ran first) but
    // the credentials are still stored — a bare "Removed" would be a lie,
    // and silence would leave the operator believing it is gone.
    expect(edits.at(-1)).toMatch(/database is locked/);
    expect(edits.at(-1)).toMatch(/credentials/i);
    expect(edits.at(-1)).not.toMatch(/^removed/i);
  });

  it('a seen-store purge failure after a successful remove is reported, not silently swallowed', async () => {
    const { deps, edits, stored } = makeDeps();
    seed(deps, 'Work');
    deps.seen.purgeAccount = vi.fn(() => {
      throw new Error('purge failed');
    });
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);
    // The credentials ARE gone here — only the seen-state purge failed — so
    // the reply must say both things truthfully rather than picking one.
    expect(stored.size).toBe(0);
    expect(edits.at(-1)).toMatch(/removed/i);
    expect(edits.at(-1)).toMatch(/purge failed/);
    expect(edits.at(-1)).toMatch(/notification history/i);
  });

  it('the remove picker offers exactly one button per mailbox, each with its own token', async () => {
    const { deps, editKeyboards } = makeDeps();
    seed(deps, 'Work');
    seed(deps, 'Home');
    await handleCallback(tap('rp'), deps);
    const removeActions = actionsIn(editKeyboards.at(-1)).filter((a) => a?.kind === 'remove');
    expect(removeActions).toHaveLength(2);
    expect(removeActions.map((a) => (a as { token: string }).token).sort()).toEqual(
      [labelToken('Home'), labelToken('Work')].sort()
    );
  });

  it('a mailbox-list read failure while resolving a token is reported, not swallowed', async () => {
    // resolveToken needs labels(). Unguarded, a SQLite failure threw into
    // handleCallback's catch: the spinner cleared and the operator got
    // nothing at all — indistinguishable from a dead bot.
    const { deps, edits } = makeDeps();
    seed(deps, 'Work');
    const token = labelToken('Work');
    deps.mailboxes.labels = () => {
      throw new Error('database is locked');
    };
    await handleCallback(tap(encodeAction({ kind: 'remove', token })), deps);
    expect(edits.at(-1)).toMatch(/database is locked/);
  });

  it('a mailbox-list read failure while building a picker is reported, not swallowed', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.labels = () => {
      throw new Error('database is locked');
    };
    await handleCallback(tap('rp'), deps);
    expect(edits.at(-1)).toMatch(/database is locked/);
  });

  it('never acts on a mailbox when the label list could not be read', async () => {
    const { deps, stored } = makeDeps();
    seed(deps, 'Work');
    deps.mailboxes.labels = () => {
      throw new Error('database is locked');
    };
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);
    expect(stored.size).toBe(1);
    expect(deps.seen.purgeAccount).not.toHaveBeenCalled();
  });

  it('test runs the probe and reports success', async () => {
    const { deps, edits, editKeyboards, probes } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Work') })), deps);
    expect(probes).toEqual(['Work']);
    expect(edits.at(-1)).toMatch(/4 folders/i);
    // A terminal result screen must offer a way back to the menu — otherwise
    // the operator is stuck once they have read it.
    expect(actionsIn(editKeyboards.at(-1))).toContainEqual({ kind: 'menu' });
  });

  it('test reports a failure without leaking the password', async () => {
    const { deps, edits } = makeDeps({
      probe: async () => ({ ok: false, reason: 'login failed for u with hunter2' }),
    });
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'hunter2', secure: true });
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Work') })), deps);
    expect(edits.at(-1)).not.toContain('hunter2');
  });

  it('a stale test token reports the mailbox is gone', async () => {
    const { deps, edits, probes } = makeDeps();
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Ghost') })), deps);
    expect(probes).toEqual([]);
    expect(edits.at(-1)).toMatch(/no longer exists|not found/i);
  });

  it('a decrypt failure on test includes the MASTER_KEY recovery hint', async () => {
    const { deps, edits, editKeyboards } = makeDeps();
    seed(deps, 'Work');
    deps.mailboxes.get = () => {
      throw new Error('bad auth tag');
    };
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Work') })), deps);
    expect(edits.at(-1)).toMatch(/bad auth tag/);
    expect(edits.at(-1)).toMatch(/MASTER_KEY/);
    expect(edits.at(-1)).toMatch(/remove it and add it again/i);
    expect(actionsIn(editKeyboards.at(-1))).toContainEqual({ kind: 'menu' });
  });
});
