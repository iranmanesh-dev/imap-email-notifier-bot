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
  mailboxes: Account[];
  sweepIntervalSeconds: number;
  previewChars: number;
  dbPath: string;
  healthPort: number;
};

export type NormalizedEmail = {
  messageId: string;
  accountLabel: string;
  folder: string;
  from: string;
  subject: string;
  preview: string;
  date: Date;
};
