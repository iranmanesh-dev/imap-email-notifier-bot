import { z } from 'zod';
import type { Config } from './types.js';

const accountSchema = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  user: z.string().min(1),
  pass: z.string().min(1),
  secure: z.boolean().default(true),
});

const mailboxesSchema = z
  .array(accountSchema)
  .min(1, 'MAILBOXES must contain at least one mailbox')
  // folder_state and the seen-message dedup table are both keyed on
  // (account_label, ...). Two mailboxes sharing a label alternately clobber
  // each other's high-water mark and each read the other's uidValidity, so
  // every sweep re-baselines and notifies nothing -- silent total mail loss
  // for both accounts, with /healthz still reporting ok. This is trivially
  // caused by copying a MAILBOXES entry and forgetting to change the label,
  // so fail loudly at boot instead of letting it wedge silently at runtime.
  .superRefine((mailboxes, ctx) => {
    const seenLabels = new Set<string>();
    mailboxes.forEach((mailbox, index) => {
      if (seenLabels.has(mailbox.label)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate mailbox label "${mailbox.label}": every mailbox must have a unique label`,
          path: [index, 'label'],
        });
      } else {
        seenLabels.add(mailbox.label);
      }
    });
  });

/** Strips values from zod issues so passwords never reach logs. */
function describeIssues(prefix: string, error: z.ZodError): string {
  const details = error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return `${prefix}: ${details}`;
}

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
  const rawMailboxes = requireVar(env, 'MAILBOXES');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawMailboxes);
  } catch {
    throw new Error('MAILBOXES must be valid JSON (an array of mailbox objects)');
  }

  const result = mailboxesSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(describeIssues('MAILBOXES is invalid', result.error));
  }

  return {
    telegramBotToken,
    telegramChatId,
    mailboxes: result.data,
    sweepIntervalSeconds: numberVar(env, 'SWEEP_INTERVAL_SECONDS', 60),
    previewChars: numberVar(env, 'PREVIEW_CHARS', 200),
    dbPath: env.DB_PATH ?? '/data/seen.db',
    healthPort: numberVar(env, 'HEALTH_PORT', 8080),
  };
}
