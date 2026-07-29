import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const validMailboxes = JSON.stringify([
  { label: 'Work', host: 'imap.hostinger.com', port: 993, user: 'me@x.com', pass: 'secret' },
]);

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123:ABC',
  TELEGRAM_CHAT_ID: '999',
  MAILBOXES: validMailboxes,
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.telegramBotToken).toBe('123:ABC');
    expect(cfg.mailboxes).toHaveLength(1);
    expect(cfg.mailboxes[0]!.label).toBe('Work');
  });

  it('applies defaults for optional settings', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.sweepIntervalSeconds).toBe(60);
    expect(cfg.previewChars).toBe(200);
    expect(cfg.dbPath).toBe('/data/seen.db');
    expect(cfg.healthPort).toBe(8080);
    expect(cfg.mailboxes[0]!.secure).toBe(true);
  });

  it('coerces numeric overrides from strings', () => {
    const cfg = loadConfig({ ...baseEnv, SWEEP_INTERVAL_SECONDS: '15', PREVIEW_CHARS: '50' });
    expect(cfg.sweepIntervalSeconds).toBe(15);
    expect(cfg.previewChars).toBe(50);
  });

  it('throws when a required variable is missing', () => {
    const { TELEGRAM_BOT_TOKEN: _omit, ...rest } = baseEnv;
    expect(() => loadConfig(rest)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws a clear error when MAILBOXES is not valid JSON', () => {
    expect(() => loadConfig({ ...baseEnv, MAILBOXES: 'not json' })).toThrow(/MAILBOXES.*JSON/i);
  });

  it('throws when MAILBOXES is an empty array', () => {
    expect(() => loadConfig({ ...baseEnv, MAILBOXES: '[]' })).toThrow(/at least one/i);
  });

  it('throws when a mailbox entry is missing a field', () => {
    const bad = JSON.stringify([{ label: 'Work', host: 'h', port: 993 }]);
    expect(() => loadConfig({ ...baseEnv, MAILBOXES: bad })).toThrow(/user/);
  });

  it('never includes passwords in error messages', () => {
    const bad = JSON.stringify([{ label: 'Work', host: 'h', port: 'nope', user: 'u', pass: 'hunter2' }]);
    try {
      loadConfig({ ...baseEnv, MAILBOXES: bad });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});
