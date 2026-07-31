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
  telegramChatId: string;
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
