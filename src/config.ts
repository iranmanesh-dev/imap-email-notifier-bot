import type { Config } from './types.js';

const MIN_MASTER_KEY_LENGTH = 32;

function requireVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function numberVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const telegramBotToken = requireVar(env, 'TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireVar(env, 'TELEGRAM_CHAT_ID');
  const masterKey = requireVar(env, 'MASTER_KEY');

  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters (generate one with: openssl rand -base64 32)`
    );
  }

  return {
    telegramBotToken,
    telegramChatId,
    masterKey,
    sweepIntervalSeconds: numberVar(env, 'SWEEP_INTERVAL_SECONDS', 60),
    previewChars: numberVar(env, 'PREVIEW_CHARS', 200),
    dbPath: env.DB_PATH ?? '/data/seen.db',
    healthPort: numberVar(env, 'HEALTH_PORT', 8080),
  };
}
