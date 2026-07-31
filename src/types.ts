export type Account = {
  label: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
};

export type Config = {
  telegramBotToken: string;
  /** The operator's chat: the only one allowed to command the bot. */
  telegramChatId: string;
  /**
   * Where email notifications are posted — a channel or group, when set.
   * Defaults to `telegramChatId`. Kept separate because that one doubles as
   * the command-authorization gate, so pointing it at a channel would both
   * break every command and invite typing mailbox passwords into it.
   */
  telegramNotifyChatId: string;
  masterKey: string;
  sweepIntervalSeconds: number;
  previewChars: number;
  dbPath: string;
  healthPort: number;
};

export type NormalizedEmail = {
  messageId: string;
  accountLabel: string;
  folder: string;
  /**
   * The address this mailbox is configured with (`Account.user`) — the
   * "to" shown in a notification. Deliberately not the message's To:
   * header: mail can arrive here via an alias, a BCC or a forward, in
   * which case the To: header names someone else entirely and answers a
   * different question than "which of my mailboxes just got this".
   */
  mailboxAddress: string;
  from: string;
  subject: string;
  preview: string;
  date: Date;
};
