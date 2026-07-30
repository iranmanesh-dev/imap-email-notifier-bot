import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdate, type CommandDeps } from '../src/telegram/commands.js';
import { Conversations } from '../src/telegram/conversation.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
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
    const { deps, replies } = makeDeps({
      probe: async () => ({ ok: false, reason: 'AUTHENTICATIONFAILED' }),
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret-pw', OPERATOR, 81), deps);
    expect(replies.join('\n')).not.toContain('s3cret-pw');
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

  it('/test never leaks the password on failure', async () => {
    const { deps, replies } = makeDeps({
      probe: async () => ({ ok: false, reason: 'login failed' }),
    });
    deps.mailboxes.add({
      label: 'Work', host: 'h', port: 993, user: 'u', pass: 'topsecret', secure: true,
    });
    await handleUpdate(msg('/test Work'), deps);
    expect(replies[0]).not.toContain('topsecret');
  });
});
