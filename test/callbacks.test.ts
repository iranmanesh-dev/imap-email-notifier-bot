import { describe, it, expect, vi } from 'vitest';
import { handleCallback, type CallbackDeps } from '../src/telegram/callbacks.js';
import { Conversations } from '../src/telegram/conversation.js';
import { encodeAction, labelToken } from '../src/telegram/keyboards.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
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
  const answers: [string, string | undefined][] = [];
  const edits: string[] = [];
  const replies: string[] = [];
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
    answer: async (id: string, text?: string) => { answers.push([id, text]); return true; },
    edit: async (_id: number, html: string) => { edits.push(html); return true; },
    reply: async (html: string) => { replies.push(html); },
    now: () => NOW,
    ...overrides,
  };
  return { deps, answers, edits, replies, stored, running, probes };
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
    expect(answers.map((a) => a[0])).toEqual(['cbq-1']);
  });

  it('answers even when the action is unrecognised', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback(tap('zzz'), deps);
    expect(answers.map((a) => a[0])).toEqual(['cbq-1']);
  });

  it('answers even when the handler throws', async () => {
    const { deps, answers } = makeDeps({
      edit: async () => { throw new Error('boom'); },
      reply: async () => { throw new Error('boom'); },
    });
    await expect(handleCallback(tap('m'), deps)).resolves.toBeUndefined();
    expect(answers.map((a) => a[0])).toEqual(['cbq-1']);
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

describe('remove and test', () => {
  function seed(deps: CallbackDeps, label: string) {
    deps.mailboxes.add({ label, host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
  }

  it('picking a mailbox asks for confirmation and deletes nothing yet', async () => {
    const { deps, edits, stored } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'remove', token: labelToken('Work') })), deps);
    expect(edits.at(-1)).toMatch(/remove/i);
    expect(stored.size).toBe(1);
  });

  it('confirming removes the mailbox, stops the watcher and purges state', async () => {
    const { deps, stored, running, edits } = makeDeps();
    seed(deps, 'Work');
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);

    expect(stored.size).toBe(0);
    expect(running.has('Work')).toBe(false);
    expect(deps.seen.purgeAccount).toHaveBeenCalledWith('Work');
    expect(edits.at(-1)).toMatch(/removed/i);
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

  it('test runs the probe and reports success', async () => {
    const { deps, edits, probes } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Work') })), deps);
    expect(probes).toEqual(['Work']);
    expect(edits.at(-1)).toMatch(/4 folders/i);
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
});
