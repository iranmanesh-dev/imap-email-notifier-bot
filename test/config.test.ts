import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123:ABC',
  TELEGRAM_CHAT_ID: '999',
  MASTER_KEY: 'k'.repeat(32),
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.telegramBotToken).toBe('123:ABC');
    expect(cfg.masterKey).toBe('k'.repeat(32));
  });

  it('applies defaults for optional settings', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.sweepIntervalSeconds).toBe(60);
    expect(cfg.previewChars).toBe(200);
    expect(cfg.dbPath).toBe('/data/seen.db');
    expect(cfg.healthPort).toBe(8080);
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

  it('throws when MASTER_KEY is missing', () => {
    const { MASTER_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadConfig(rest)).toThrow(/MASTER_KEY/);
  });

  it('throws when MASTER_KEY is too short, and says how to make one', () => {
    expect(() => loadConfig({ ...baseEnv, MASTER_KEY: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...baseEnv, MASTER_KEY: 'short' })).toThrow(/openssl rand/);
  });

  it('never includes the master key itself in an error message', () => {
    try {
      loadConfig({ ...baseEnv, MASTER_KEY: 'sekrit' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('sekrit');
    }
  });

  it('ignores a leftover MAILBOXES variable', () => {
    const cfg = loadConfig({ ...baseEnv, MAILBOXES: '[{"label":"x"}]' });
    expect(cfg).not.toHaveProperty('mailboxes');
  });

  it('trims surrounding whitespace from TELEGRAM_CHAT_ID', () => {
    const cfg = loadConfig({ ...baseEnv, TELEGRAM_CHAT_ID: '  999  \n' });
    expect(cfg.telegramChatId).toBe('999');
  });
});
