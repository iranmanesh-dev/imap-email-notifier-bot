import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdate, type CommandDeps } from '../src/telegram/commands.js';
import { Conversations } from '../src/telegram/conversation.js';
import { hostPickKeyboard } from '../src/telegram/keyboards.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
import type { InlineKeyboard } from '../src/telegram/sender.js';
import type { Account } from '../src/types.js';

const OPERATOR = 42;
const NOW = 1_000_000;

function msg(text: string, chatId = OPERATOR, messageId = 1): TelegramUpdate {
  return { update_id: 1, message: { message_id: messageId, chat: { id: chatId }, text } };
}

function makeDeps(overrides: Partial<CommandDeps> = {}) {
  const stored = new Map<string, Account>();
  const running = new Set<string>();
  const replies: string[] = [];
  const deleted: number[] = [];

  const deps: CommandDeps = {
    operatorChatId: String(OPERATOR),
    mailboxes: {
      add: (a: Account) => {
        if (stored.has(a.label)) throw new Error(`a mailbox labelled "${a.label}" already exists`);
        stored.set(a.label, a);
      },
      list: () => [...stored.values()].map((a) => ({
        label: a.label, host: a.host, port: a.port, username: a.user,
      })),
      get: (l: string) => stored.get(l) ?? null,
      remove: (l: string) => stored.delete(l),
      labels: () => [...stored.keys()],
    } as unknown as CommandDeps['mailboxes'],
    seen: { purgeAccount: vi.fn(() => 3) },
    registry: {
      add: async (a: Account) => { running.add(a.label); },
      remove: async (l: string) => running.delete(l),
      has: (l: string) => running.has(l),
      states: () => [...running].map((l) => ({ label: l, state: 'ok' as const })),
      size: () => running.size,
    } as unknown as CommandDeps['registry'],
    conversations: new Conversations(),
    probe: async () => ({ ok: true, folders: 5 }),
    reply: async (t: string) => { replies.push(t); },
    deleteMessage: async (id: number) => { deleted.push(id); return true; },
    now: () => NOW,
    ...overrides,
  };
  return { deps, replies, deleted, stored, running };
}

describe('authorization', () => {
  it('ignores messages from any other chat entirely', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/list', 999), deps);
    expect(replies).toEqual([]);
  });

  it('ignores an unauthorized chat even for an unknown command', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('anything at all', 999), deps);
    expect(replies).toEqual([]);
  });

  it('ignores updates with no message', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate({ update_id: 1 }, deps);
    expect(replies).toEqual([]);
  });

  it('ignores an update whose message has no chat', async () => {
    const { deps, replies } = makeDeps();
    const update = { update_id: 1, message: { message_id: 1, text: '/list' } } as unknown as TelegramUpdate;
    await handleUpdate(update, deps);
    expect(replies).toEqual([]);
  });

  it('touches nothing at all for an unauthorized chat — no probe, no delete, no store write', async () => {
    const probe = vi.fn(async () => ({ ok: true, folders: 5 }) as const);
    const deleteMessage = vi.fn(async () => true);
    const { deps, replies, stored } = makeDeps({ probe, deleteMessage });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com', 999), deps);
    expect(replies).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });
});

describe('/add', () => {
  it('asks for the password and does not save yet', async () => {
    const { deps, replies, stored } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    expect(replies[0]).toMatch(/password/i);
    expect(stored.size).toBe(0);
  });

  it('rejects wrong argument counts with usage', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com'), deps);
    expect(replies[0]).toMatch(/usage/i);
  });

  it('rejects a non-numeric port', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com notaport me@example.com'), deps);
    expect(replies[0]).toMatch(/port/i);
  });

  it('rejects a duplicate label before prompting for a password', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    expect(replies[0]).toMatch(/already exists/i);
  });

  it('deletes the password message, probes, saves and starts the watcher', async () => {
    const { deps, replies, deleted, stored, running } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 77), deps);

    expect(deleted).toContain(77);
    expect(stored.get('Work')?.pass).toBe('s3cret');
    expect(running.has('Work')).toBe(true);
    expect(replies.at(-1)).toMatch(/5 folders/i);
  });

  it('does not save when the probe fails', async () => {
    const { deps, replies, stored, running } = makeDeps({
      probe: async () => ({ ok: false, reason: 'AUTHENTICATIONFAILED' }),
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('wrong-pw', OPERATOR, 78), deps);

    expect(stored.size).toBe(0);
    expect(running.size).toBe(0);
    expect(replies.at(-1)).toMatch(/AUTHENTICATIONFAILED/);
  });

  it('warns when the password message could not be deleted', async () => {
    const { deps, replies } = makeDeps({ deleteMessage: async () => false });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 79), deps);
    expect(replies.some((r) => /could not delete/i.test(r))).toBe(true);
  });

  it('never echoes the password back', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 80), deps);
    expect(replies.join('\n')).not.toContain('s3cret');
  });

  it('never echoes the password in the probe-failure reply', async () => {
    // The probe reason must actually CONTAIN the password for this
    // assertion to be load-bearing. A stub returning a constant like
    // 'AUTHENTICATIONFAILED' — a string that never held the password —
    // makes the assertion trivially true and would pass against any
    // implementation. A server echoing the rejected LOGIN back is the real
    // failure mode, and is why probe.ts scrubs at all.
    const { deps, replies } = makeDeps({
      probe: async (a: Account) => ({
        ok: false as const,
        reason: `login failed for ${a.user} with ${a.pass}`,
      }),
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret-pw', OPERATOR, 81), deps);
    expect(replies.join('\n')).not.toContain('s3cret-pw');
    expect(replies.at(-1)).toContain('***'); // scrubbed, not merely absent
  });

  it('never echoes the password in the delete-failure warning', async () => {
    const { deps, replies } = makeDeps({ deleteMessage: async () => false });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret-pw', OPERATOR, 82), deps);
    expect(replies.join('\n')).not.toContain('s3cret-pw');
  });

  it('never echoes the password when mailboxes.add throws an error containing it', async () => {
    const { deps, replies } = makeDeps({
      mailboxes: {
        add: (a: Account) => {
          throw new Error(`db locked, could not store password "${a.pass}"`);
        },
        list: () => [],
        get: () => null,
        remove: () => false,
        labels: () => [],
      } as unknown as CommandDeps['mailboxes'],
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('leaked-secret', OPERATOR, 83), deps);
    expect(replies.join('\n')).not.toContain('leaked-secret');
  });

  it('reports a distinct failure when the watcher fails to start after the mailbox was saved', async () => {
    const { deps, replies, stored } = makeDeps({
      registry: {
        add: async () => {
          throw new Error('watcher start failed');
        },
        remove: async () => false,
        has: () => false,
        states: () => [],
        size: () => 0,
      } as unknown as CommandDeps['registry'],
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 90), deps);

    expect(stored.get('Work')?.pass).toBe('s3cret');
    expect(replies.at(-1)).toMatch(/saved/i);
    expect(replies.at(-1)).toMatch(/not watching|failed to start watching/i);
    expect(replies.at(-1)).not.toMatch(/^Failed to save/);
  });

  it('announces a cancelled pending password prompt when a command arrives instead', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('/status'), deps);

    expect(replies.some((r) => /cancel/i.test(r) && /work/i.test(r))).toBe(true);
    expect(replies.at(-1)).toMatch(/no mailboxes/i);
  });

  it('ignores a bare message when nothing is pending', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('just chatting'), deps);
    expect(replies[0]).toMatch(/unknown command|usage/i);
  });
});

describe('/list', () => {
  it('reports emptiness clearly', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/list'), deps);
    expect(replies[0]).toMatch(/no mailboxes/i);
  });

  it('masks the password', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({
      label: 'Work', host: 'imap.example.com', port: 993,
      user: 'me@example.com', pass: 'hunter2', secure: true,
    });
    await handleUpdate(msg('/list'), deps);
    expect(replies[0]).toContain('Work');
    expect(replies[0]).toContain('me@example.com');
    expect(replies[0]).not.toContain('hunter2');
    expect(replies[0]).toContain('••••••••');
  });
});

describe('/remove', () => {
  it('asks for confirmation and does not delete yet', async () => {
    const { deps, replies, stored } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    expect(replies[0]).toMatch(/yes/i);
    expect(stored.size).toBe(1);
  });

  it('deletes the mailbox, stops the watcher and purges state on yes', async () => {
    const { deps, replies, stored, running } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('yes'), deps);

    expect(stored.size).toBe(0);
    expect(running.has('Work')).toBe(false);
    expect(deps.seen.purgeAccount).toHaveBeenCalledWith('Work');
    expect(replies.at(-1)).toMatch(/removed/i);
  });

  it('cancels on any other reply', async () => {
    const { deps, replies, stored } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('no'), deps);
    expect(stored.size).toBe(1);
    expect(replies.at(-1)).toMatch(/cancel/i);
  });

  it('reports an unknown label', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/remove Ghost'), deps);
    expect(replies[0]).toMatch(/no mailbox/i);
  });

  // Deleted with the branch it covered: a "watcher fails to stop -> skip the
  // rest" test used to live here, but WatcherRegistry.remove() catches every
  // stop() error internally and always returns true for a known label, so
  // that production path did not exist. See completeRemove for why reporting
  // a stop failure would be the wrong behaviour anyway.

  it('does not claim to have stopped a watcher when none was running, but still removes the credentials', async () => {
    const { deps, replies, stored } = makeDeps();
    // Saved but never watched — e.g. skipped during the startup restore.
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('yes'), deps);

    expect(stored.size).toBe(0); // credentials still removed
    expect(deps.seen.purgeAccount).toHaveBeenCalledWith('Work');
    expect(replies.at(-1)).toMatch(/removed/i);
    expect(replies.at(-1)).toMatch(/not being watched|nothing to stop/i);
    expect(replies.at(-1)).not.toMatch(/and stopped watching it/i);
  });

  it('purges the seen-state only after the watcher has been stopped, never before', async () => {
    // Ordering regression: completeRemove must not purge while the watcher
    // could still be writing. The registry stub records the order so a
    // future reordering of completeRemove is caught here, while
    // watcher.test.ts covers the drain inside stop() itself.
    const order: string[] = [];
    const { deps } = makeDeps({
      registry: {
        add: async () => {},
        remove: async (l: string) => {
          await new Promise((r) => setTimeout(r, 10));
          order.push(`stopped:${l}`);
          return true;
        },
        has: () => false,
        states: () => [],
        size: () => 0,
      } as unknown as CommandDeps['registry'],
      seen: {
        purgeAccount: vi.fn((l: string) => {
          order.push(`purged:${l}`);
          return 3;
        }),
      },
    });
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('yes'), deps);

    expect(order).toEqual(['stopped:Work', 'purged:Work']);
  });

  it('reports partial completion when removing stored credentials fails', async () => {
    const { deps, replies } = makeDeps({
      mailboxes: {
        add: () => {},
        list: () => [{ label: 'Work', host: 'h', port: 993, username: 'u' }],
        get: (l: string) =>
          l === 'Work' ? { label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true } : null,
        remove: () => {
          throw new Error('disk error');
        },
        labels: () => ['Work'],
      } as unknown as CommandDeps['mailboxes'],
    });
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('yes'), deps);

    expect(deps.registry.has('Work')).toBe(false);
    expect(deps.seen.purgeAccount).not.toHaveBeenCalled();
    expect(replies.at(-1)).toMatch(/stopped watching|credentials/i);
  });

  it('announces a cancelled pending removal confirmation when a command arrives instead', async () => {
    const { deps, replies, stored } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('/list'), deps);

    expect(replies.some((r) => /cancel/i.test(r) && /work/i.test(r))).toBe(true);
    expect(stored.size).toBe(1);
    expect(replies.at(-1)).toContain('Work');
  });
});

describe('/status and /test', () => {
  it('reports idle when nothing is configured', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/status'), deps);
    expect(replies[0]).toMatch(/no mailboxes/i);
  });

  it('reports each watcher state', async () => {
    const { deps, replies } = makeDeps();
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/status'), deps);
    expect(replies[0]).toContain('Work');
    expect(replies[0]).toContain('ok');
  });

  // /list reads only the store; /status read only the registry, and nothing
  // reconciled them. A mailbox skipped during the startup restore, or one
  // where /add persisted but the watcher failed to start, looked perfectly
  // normal in /list and never appeared in /status at all — while the spec
  // calls /status the operator's only view into connection health.

  it('/status flags a saved mailbox that has no watcher running', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Ghosted', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleUpdate(msg('/status'), deps);

    expect(replies[0]).toContain('Work');
    expect(replies[0]).toContain('ok');
    expect(replies[0]).toContain('Ghosted');
    expect(replies[0]).toMatch(/not being watched/i);
  });

  it('/status does not claim nothing is configured when every saved mailbox is unwatched', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Ghosted', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleUpdate(msg('/status'), deps);

    expect(replies[0]).toContain('Ghosted');
    expect(replies[0]).toMatch(/not being watched/i);
    expect(replies[0]).not.toMatch(/^No mailboxes are being watched/);
  });

  it('/test reports success for a saved mailbox', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/test Work'), deps);
    expect(replies[0]).toMatch(/5 folders/i);
  });

  it('/test reports an unknown label', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/test Ghost'), deps);
    expect(replies[0]).toMatch(/no mailbox/i);
  });

  it('/test replies instead of going silent when the stored credentials cannot be decrypted', async () => {
    // mailboxes.get() decrypts, so it throws on a rotated/wrong MASTER_KEY
    // or a tampered row. Unwrapped, that throw escaped handleUpdate and the
    // operator got NO reply at all — only a line in the container log. This
    // is the single most likely reason to reach for /test: the operator
    // rotated MASTER_KEY, saw the boot alert, and is diagnosing. Silence is
    // indistinguishable from "mail stopped arriving".
    const { deps, replies } = makeDeps({
      mailboxes: {
        add: () => {},
        list: () => [{ label: 'Work', host: 'h', port: 993, username: 'u' }],
        get: () => {
          throw new Error('Unsupported state or unable to authenticate data');
        },
        remove: () => false,
        labels: () => ['Work'],
      } as unknown as CommandDeps['mailboxes'],
    });

    await expect(handleUpdate(msg('/test Work'), deps)).resolves.toBeUndefined();

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Work');
    expect(replies[0]).toMatch(/could not read|could not decrypt/i);
    expect(replies[0]).toContain('MASTER_KEY');
  });

  it('/test never leaks the password on failure', async () => {
    // Same reasoning as the /add probe-failure test: the reason has to
    // embed the password, or the assertion holds for free.
    const { deps, replies } = makeDeps({
      probe: async (a: Account) => ({
        ok: false as const,
        reason: `login failed for ${a.user} with ${a.pass}`,
      }),
    });
    deps.mailboxes.add({
      label: 'Work', host: 'h', port: 993, user: 'u', pass: 'topsecret', secure: true,
    });
    await handleUpdate(msg('/test Work'), deps);
    expect(replies[0]).not.toContain('topsecret');
    expect(replies[0]).toContain('***'); // scrubbed, not merely absent
  });
});

describe('wizard typed steps', () => {
  it('a typed label advances to the host step', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-label', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('Work'), deps);
    expect(replies.at(-1)).toMatch(/host/i);
  });

  it('the host prompt carries a host quick-pick keyboard, since typing is the more typo-prone field', async () => {
    const keyboards: (InlineKeyboard | undefined)[] = [];
    const { deps } = makeDeps({
      reply: async (_text: string, keyboard?: InlineKeyboard) => {
        keyboards.push(keyboard);
      },
    });
    deps.conversations.set(OPERATOR, { kind: 'wizard-label', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('Work'), deps);
    expect(keyboards.at(-1)).toEqual(hostPickKeyboard());
  });

  it('a typed host advances to the port step', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('imap.example.com'), deps);
    expect(replies.at(-1)).toMatch(/port/i);
  });

  it('an invalid typed port re-prompts without advancing, and a subsequent valid port still advances', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'W', host: 'h', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('not-a-port'), deps);
    expect(replies.at(-1)).toMatch(/port/i);
    expect(deps.conversations.size()).toBe(1);

    // Asserting only size() === 1 would also pass if the re-set entry had
    // silently become the wrong kind. Driving one more, valid port through
    // proves the retained state is still genuinely `wizard-port` with its
    // label and host intact.
    await handleUpdate(msg('993'), deps);
    expect(replies.at(-1)).toMatch(/username|email/i);
  });

  it('a typed username advances to the password prompt', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-username', label: 'W', host: 'h', port: 993, expiresAt: NOW + 60_000 });
    await handleUpdate(msg('me@example.com'), deps);
    expect(replies.at(-1)).toMatch(/password/i);
  });

  it('the wizard ends in the same probe-and-persist path as the typed command', async () => {
    const { deps, stored, running, deleted } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-username', label: 'W', host: 'h', port: 993, expiresAt: NOW + 60_000 });
    await handleUpdate(msg('me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 88), deps);

    expect(deleted).toContain(88);
    expect(stored.get('W')?.pass).toBe('s3cret');
    expect(running.has('W')).toBe(true);
  });

  it('a command sent mid-wizard cancels it with a notice', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'W', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('/list'), deps);
    expect(replies.some((r) => /cancel/i.test(r))).toBe(true);
  });

  it('rejects a duplicate label at the label step, before a password is ever solicited', async () => {
    // /add pre-checks the label. The wizard did not, so the operator walked
    // all five steps, sent a password, had it deleted, and a real IMAP login
    // ran — and only then did mailboxes.add throw "already exists".
    const { deps, replies, deleted } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    deps.conversations.set(OPERATOR, { kind: 'wizard-label', expiresAt: NOW + 60_000 });

    await handleUpdate(msg('Work'), deps);

    expect(replies.at(-1)).toMatch(/already exists/i);
    expect(replies.at(-1)).not.toMatch(/which imap host/i);
    expect(deleted).toEqual([]);
  });

  it('stays on the label step after a duplicate, so another label can just be sent', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    deps.conversations.set(OPERATOR, { kind: 'wizard-label', expiresAt: NOW + 60_000 });

    await handleUpdate(msg('Work'), deps);
    await handleUpdate(msg('Home'), deps);

    expect(replies.at(-1)).toMatch(/which imap host/i);
  });
});

describe('completing an add', () => {
  function keyboardCapture() {
    const keyboards: (InlineKeyboard | undefined)[] = [];
    return {
      keyboards,
      reply: async (_text: string, keyboard?: InlineKeyboard) => { keyboards.push(keyboard); },
    };
  }

  it('ends a successful add with a keyboard, so a button-driven add has a way back', async () => {
    // The wizard's last two steps are typed, so a button-driven add lands in
    // completeAdd. With no keyboard on the terminal message the operator is
    // left with no way back into the menu.
    const { reply, keyboards } = keyboardCapture();
    const { deps } = makeDeps({ reply });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 91), deps);
    expect(keyboards.at(-1)).toBeDefined();
  });

  it('ends a failed add with a keyboard too', async () => {
    const { reply, keyboards } = keyboardCapture();
    const { deps } = makeDeps({ reply, probe: async () => ({ ok: false, reason: 'AUTHENTICATIONFAILED' }) });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('wrong-pw', OPERATOR, 92), deps);
    expect(keyboards.at(-1)).toBeDefined();
  });

  it('ends a saved-but-unwatched add with a keyboard too', async () => {
    const { reply, keyboards } = keyboardCapture();
    const { deps } = makeDeps({
      reply,
      registry: {
        add: async () => { throw new Error('watcher start failed'); },
        remove: async () => false, has: () => false, states: () => [], size: () => 0,
      } as unknown as CommandDeps['registry'],
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 93), deps);
    expect(keyboards.at(-1)).toBeDefined();
  });
});
