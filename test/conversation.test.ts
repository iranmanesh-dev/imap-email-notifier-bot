import { describe, it, expect } from 'vitest';
import { Conversations, PASSWORD_TTL_MS, type Pending } from '../src/telegram/conversation.js';

const NOW = 1_000_000;

function pwPending(expiresAt = NOW + PASSWORD_TTL_MS): Pending {
  return { kind: 'password', label: 'Work', host: 'h', port: 993, username: 'u', expiresAt };
}

describe('Conversations', () => {
  it('returns null when nothing is pending', () => {
    expect(new Conversations().take(1, NOW)).toBeNull();
  });

  it('returns a pending entry that has not expired', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    expect(c.take(1, NOW)).toMatchObject({ kind: 'password', label: 'Work' });
  });

  it('is single-use — a second take returns null', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    c.take(1, NOW);
    expect(c.take(1, NOW)).toBeNull();
  });

  it('returns null once expired, and does not resurrect later', () => {
    const c = new Conversations();
    c.set(1, pwPending(NOW - 1));
    expect(c.take(1, NOW)).toBeNull();
    expect(c.take(1, NOW)).toBeNull();
  });

  it('treats an entry expiring exactly now as expired', () => {
    const c = new Conversations();
    c.set(1, pwPending(NOW));
    expect(c.take(1, NOW)).toBeNull();
  });

  it('keeps chats independent', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    expect(c.take(2, NOW)).toBeNull();
    expect(c.take(1, NOW)).not.toBeNull();
  });

  it('replaces a pending entry when a new one is set', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    c.set(1, { kind: 'remove-confirm', label: 'Personal', expiresAt: NOW + 1000 });
    expect(c.take(1, NOW)).toMatchObject({ kind: 'remove-confirm', label: 'Personal' });
    expect(c.size()).toBe(0);
  });

  it('clear removes a pending entry', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    c.clear(1);
    expect(c.take(1, NOW)).toBeNull();
  });

  it('drops the entry from storage when it expires, rather than leaking', () => {
    const c = new Conversations();
    c.set(1, pwPending(NOW - 1));
    c.take(1, NOW);
    expect(c.size()).toBe(0);
  });
});
