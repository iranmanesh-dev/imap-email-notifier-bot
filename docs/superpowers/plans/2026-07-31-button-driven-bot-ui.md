# Button-Driven Bot UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace typed bot commands with an inline-keyboard menu and a guided add wizard, so mailboxes can be managed by tapping rather than composing command lines.

**Architecture:** The receiver gains `callback_query` support. A new `keyboards.ts` builds inline keyboards and encodes/decodes callback data as short action tokens, using an 8-hex-character hash of a mailbox label to stay inside Telegram's 64-byte `callback_data` cap. A new `callbacks.ts` dispatches taps behind the same operator-chat gate as `commands.ts`. Typed commands are retained unchanged.

**Tech Stack:** Node 22, TypeScript, vitest, node:crypto, Telegram Bot API inline keyboards.

## Global Constraints

- ESM, TypeScript `module: nodenext`. Local imports inside `src/` MUST use the `.js` extension even though sources are `.ts`.
- **The operator-chat gate must cover callback queries.** The existing gate inspects `message.chat.id` only, so callbacks would bypass authorization entirely. An unauthorized callback gets no reply and has no side effect.
- **`answerCallbackQuery` must be called for every tap, on every path including thrown errors**, or the operator's client shows a spinner until it times out.
- **`callback_data` is capped at 64 bytes.** Never embed a raw mailbox label.
- Never log, echo, or reply with a mailbox password, the bot token, or the master key.
- Telegram refuses to edit messages older than 48 hours — editing in place always needs a send fallback.
- Test framework is `vitest`. `npm test` stays fast and Docker-free.
- **Regression gate: all 37 existing tests in `test/commands.test.ts` must pass unchanged.** That is what proves typed commands were genuinely retained.

---

### Task 1: Sender API for keyboards and callbacks

**Files:**
- Modify: `src/telegram/sender.ts`
- Test: `test/sender.test.ts`

**Interfaces:**
- Consumes: the existing `TelegramSender` with `#baseUrl`, `#fetch`, `send(html)`, `deleteMessage(chatId, messageId)`.
- Produces:
  - `type InlineButton = { text: string; callback_data: string }`
  - `type InlineKeyboard = InlineButton[][]`
  - `send(html: string, keyboard?: InlineKeyboard): Promise<SendOutcome>` — existing signature, optional second parameter
  - `answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>`
  - `editMessageText(chatId: string, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<boolean>`

`send` deliberately does NOT return a message id. The wizard edits the message a button was attached to, whose id arrives on the callback query, so no id plumbing is needed.

- [ ] **Step 1: Write the failing tests**

Append to `test/sender.test.ts`:

```ts
describe('keyboards and callbacks', () => {
  it('includes reply_markup when a keyboard is passed to send', async () => {
    const calls: RequestInit[] = [];
    const sender = makeSender((async (_u: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    await sender.send('<b>hi</b>', [[{ text: 'Add', callback_data: 'a' }]]);

    const body = JSON.parse(calls[0]!.body as string);
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Add', callback_data: 'a' }]] });
  });

  it('omits reply_markup entirely when no keyboard is passed', async () => {
    const calls: RequestInit[] = [];
    const sender = makeSender((async (_u: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    await sender.send('<b>hi</b>');

    expect(JSON.parse(calls[0]!.body as string)).not.toHaveProperty('reply_markup');
  });

  it('answerCallbackQuery posts the id and reports success', async () => {
    const calls: [string, RequestInit][] = [];
    const sender = makeSender((async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    expect(await sender.answerCallbackQuery('cbq-1', 'done')).toBe(true);
    expect(calls[0]![0]).toContain('/answerCallbackQuery');
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      callback_query_id: 'cbq-1',
      text: 'done',
    });
  });

  it('answerCallbackQuery omits text when not supplied', async () => {
    const calls: RequestInit[] = [];
    const sender = makeSender((async (_u: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    await sender.answerCallbackQuery('cbq-1');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ callback_query_id: 'cbq-1' });
  });

  it('answerCallbackQuery reports false rather than throwing on a network error', async () => {
    const sender = makeSender((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await sender.answerCallbackQuery('cbq-1')).toBe(false);
  });

  it('editMessageText posts chat, message id, HTML and keyboard', async () => {
    const calls: [string, RequestInit][] = [];
    const sender = makeSender((async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    const ok = await sender.editMessageText('42', 7, '<b>x</b>', [[{ text: 'B', callback_data: 'b' }]]);

    expect(ok).toBe(true);
    expect(calls[0]![0]).toContain('/editMessageText');
    const body = JSON.parse(calls[0]![1].body as string);
    expect(body).toMatchObject({
      chat_id: '42',
      message_id: 7,
      text: '<b>x</b>',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'B', callback_data: 'b' }]] },
    });
  });

  it('editMessageText reports false when Telegram refuses (message too old)', async () => {
    const sender = makeSender(
      (async () => jsonResponse(400, { ok: false, description: 'message to edit not found' })) as unknown as typeof fetch
    );
    expect(await sender.editMessageText('42', 7, 'x')).toBe(false);
  });

  it('editMessageText reports false rather than throwing on a network error', async () => {
    const sender = makeSender((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await sender.editMessageText('42', 7, 'x')).toBe(false);
  });

  it('never puts the bot token in a returned value', async () => {
    const sender = new TelegramSender({
      token: 'SECRETTOKEN', chatId: '42',
      fetchImpl: (async () => { throw new Error('boom'); }) as unknown as typeof fetch,
      sleep: async () => {}, minIntervalMs: 0,
    });
    expect(String(await sender.answerCallbackQuery('x'))).not.toContain('SECRETTOKEN');
    expect(String(await sender.editMessageText('42', 1, 'x'))).not.toContain('SECRETTOKEN');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sender.test.ts`
Expected: FAIL — `answerCallbackQuery` and `editMessageText` are not functions.

- [ ] **Step 3: Implement the additions**

In `src/telegram/sender.ts`, add the exported types near the top:

```ts
export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];
```

Change `send` and `#post` to carry an optional keyboard. `send` currently reads
`send(html: string): Promise<SendOutcome>` and passes `html` through the queue to
`#sendNow`; thread the keyboard the same way, defaulting to `undefined`.

In `#post`, after the existing `body` object is built and before the fetch:

```ts
    if (keyboard !== undefined) {
      body.reply_markup = { inline_keyboard: keyboard };
    }
```

Then append these two methods to the class:

```ts
  /**
   * Answers a callback query. MUST be called for every button tap, on every
   * path including failures, or the operator's Telegram client shows a
   * spinner on the button until it times out.
   *
   * Returns false rather than throwing — a failed answer is cosmetic and
   * must never abort the action the tap requested.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text !== undefined) body.text = text;
    try {
      const res = await this.#fetch(`${this.#baseUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Edits a message in place, so a multi-step wizard does not leave one
   * message per step in the chat.
   *
   * Returns false rather than throwing. Telegram refuses to edit messages
   * older than 48 hours, so callers must fall back to sending a new message
   * — otherwise tapping a button on a day-old menu silently does nothing.
   */
  async editMessageText(
    chatId: string,
    messageId: number,
    html: string,
    keyboard?: InlineKeyboard
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (keyboard !== undefined) body.reply_markup = { inline_keyboard: keyboard };
    try {
      const res = await this.#fetch(`${this.#baseUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sender.test.ts`
Expected: PASS, including every pre-existing sender test.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/sender.ts test/sender.test.ts
git commit -m "feat: sender support for inline keyboards, callback answers and edits"
```

---

### Task 2: Callback data encoding and keyboard builders

**Files:**
- Create: `src/telegram/keyboards.ts`
- Test: `test/keyboards.test.ts`

**Interfaces:**
- Consumes: `InlineKeyboard` from `src/telegram/sender.js`.
- Produces:
  - `type CallbackAction` — the discriminated union listed in the implementation below
  - `function labelToken(label: string): string` — 8 lowercase hex characters
  - `function resolveToken(token: string, labels: string[]): string | null`
  - `function encodeAction(action: CallbackAction): string`
  - `function decodeAction(data: string): CallbackAction | null`
  - `function menuKeyboard(): InlineKeyboard`
  - `function mailboxKeyboard(labels: string[], target: 'remove' | 'test'): InlineKeyboard`
  - `function confirmRemoveKeyboard(token: string): InlineKeyboard`
  - `function hostPickKeyboard(): InlineKeyboard`
  - `function portPickKeyboard(): InlineKeyboard`
  - `function cancelKeyboard(): InlineKeyboard`
  - `function backKeyboard(): InlineKeyboard`
  - `const CALLBACK_DATA_MAX_BYTES = 64`

- [ ] **Step 1: Write the failing test**

Create `test/keyboards.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  labelToken, resolveToken, encodeAction, decodeAction,
  menuKeyboard, mailboxKeyboard, confirmRemoveKeyboard,
  hostPickKeyboard, portPickKeyboard, cancelKeyboard, backKeyboard,
  CALLBACK_DATA_MAX_BYTES, type CallbackAction,
} from '../src/telegram/keyboards.js';

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

describe('labelToken', () => {
  it('is stable for the same label', () => {
    expect(labelToken('Work')).toBe(labelToken('Work'));
  });

  it('differs for different labels', () => {
    expect(labelToken('Work')).not.toBe(labelToken('Personal'));
  });

  it('is 8 lowercase hex characters', () => {
    expect(labelToken('Work')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles unicode and very long labels', () => {
    expect(labelToken('Ünïcødé 📬 ' + 'x'.repeat(500))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('resolveToken', () => {
  it('finds the label whose token matches', () => {
    expect(resolveToken(labelToken('Work'), ['Personal', 'Work'])).toBe('Work');
  });

  it('returns null when nothing matches — a stale button', () => {
    expect(resolveToken(labelToken('Deleted'), ['Work'])).toBeNull();
  });

  it('returns null for an empty label list', () => {
    expect(resolveToken(labelToken('Work'), [])).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(resolveToken('not-a-token', ['Work'])).toBeNull();
  });
});

describe('encode/decode round-trip', () => {
  const cases: CallbackAction[] = [
    { kind: 'menu' },
    { kind: 'add' },
    { kind: 'list' },
    { kind: 'status' },
    { kind: 'cancel' },
    { kind: 'remove-pick' },
    { kind: 'test-pick' },
    { kind: 'remove', token: 'a1b2c3d4' },
    { kind: 'remove-confirm', token: 'a1b2c3d4' },
    { kind: 'test', token: 'a1b2c3d4' },
    { kind: 'host', value: 'imap.hostinger.com' },
    { kind: 'port', value: 993 },
    { kind: 'type-host' },
    { kind: 'type-port' },
  ];

  it.each(cases)('round-trips %j', (action) => {
    expect(decodeAction(encodeAction(action))).toEqual(action);
  });

  it.each(cases)('stays within the 64-byte cap for %j', (action) => {
    expect(byteLen(encodeAction(action))).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('returns null for unknown data rather than throwing', () => {
    expect(decodeAction('zzz')).toBeNull();
    expect(decodeAction('')).toBeNull();
    expect(decodeAction('r:')).toBeNull();
  });

  it('returns null for a non-numeric port', () => {
    expect(decodeAction('p:abc')).toBeNull();
  });

  it('does not confuse test-pick with type-port', () => {
    expect(decodeAction(encodeAction({ kind: 'test-pick' }))).toEqual({ kind: 'test-pick' });
    expect(decodeAction(encodeAction({ kind: 'type-port' }))).toEqual({ kind: 'type-port' });
    expect(encodeAction({ kind: 'test-pick' })).not.toBe(encodeAction({ kind: 'type-port' }));
  });
});

describe('keyboards', () => {
  it('menu offers every action', () => {
    const flat = menuKeyboard().flat();
    const kinds = flat.map((b) => decodeAction(b.callback_data)?.kind);
    expect(kinds).toEqual(expect.arrayContaining(['add', 'list', 'status', 'remove-pick', 'test-pick']));
  });

  it('mailbox keyboard has one button per label plus a back button', () => {
    const kb = mailboxKeyboard(['Work', 'Personal'], 'remove');
    const flat = kb.flat();
    expect(flat.filter((b) => decodeAction(b.callback_data)?.kind === 'remove')).toHaveLength(2);
    expect(flat.some((b) => decodeAction(b.callback_data)?.kind === 'menu')).toBe(true);
  });

  it('mailbox keyboard encodes the label token, never the raw label', () => {
    const kb = mailboxKeyboard(['A very long mailbox label indeed'.repeat(4)], 'test');
    const button = kb.flat()[0]!;
    expect(button.callback_data).not.toContain('very long');
    expect(byteLen(button.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('mailbox keyboard shows the label as the visible button text', () => {
    expect(mailboxKeyboard(['Work'], 'remove').flat()[0]!.text).toContain('Work');
  });

  it('every generated button stays within the byte cap', () => {
    const all = [
      ...menuKeyboard().flat(),
      ...mailboxKeyboard(['Work'], 'remove').flat(),
      ...confirmRemoveKeyboard('a1b2c3d4').flat(),
      ...hostPickKeyboard().flat(),
      ...portPickKeyboard().flat(),
      ...cancelKeyboard().flat(),
      ...backKeyboard().flat(),
    ];
    for (const b of all) {
      expect(byteLen(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('every generated button decodes to a known action', () => {
    const all = [
      ...menuKeyboard().flat(),
      ...mailboxKeyboard(['Work'], 'test').flat(),
      ...confirmRemoveKeyboard('a1b2c3d4').flat(),
      ...hostPickKeyboard().flat(),
      ...portPickKeyboard().flat(),
      ...cancelKeyboard().flat(),
      ...backKeyboard().flat(),
    ];
    for (const b of all) {
      expect(decodeAction(b.callback_data)).not.toBeNull();
    }
  });

  it('confirm keyboard offers exactly confirm and cancel', () => {
    const kinds = confirmRemoveKeyboard('a1b2c3d4').flat().map((b) => decodeAction(b.callback_data)?.kind);
    expect(kinds).toEqual(expect.arrayContaining(['remove-confirm', 'cancel']));
  });

  it('host picks include a manual-entry option', () => {
    const kinds = hostPickKeyboard().flat().map((b) => decodeAction(b.callback_data)?.kind);
    expect(kinds).toContain('type-host');
    expect(kinds).toContain('host');
  });

  it('port picks offer 993 and a manual-entry option', () => {
    const actions = portPickKeyboard().flat().map((b) => decodeAction(b.callback_data));
    expect(actions).toContainEqual({ kind: 'port', value: 993 });
    expect(actions.map((a) => a?.kind)).toContain('type-port');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/keyboards.test.ts`
Expected: FAIL — cannot resolve `../src/telegram/keyboards.js`.

- [ ] **Step 3: Implement `src/telegram/keyboards.ts`**

```ts
import { createHash } from 'node:crypto';
import type { InlineKeyboard } from './sender.js';

/** Telegram's hard limit on callback_data. */
export const CALLBACK_DATA_MAX_BYTES = 64;

export type CallbackAction =
  | { kind: 'menu' }
  | { kind: 'add' }
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'cancel' }
  | { kind: 'remove-pick' }
  | { kind: 'test-pick' }
  | { kind: 'remove'; token: string }
  | { kind: 'remove-confirm'; token: string }
  | { kind: 'test'; token: string }
  | { kind: 'host'; value: string }
  | { kind: 'port'; value: number }
  | { kind: 'type-host' }
  | { kind: 'type-port' };

/**
 * A short, stable identifier for a mailbox label.
 *
 * callback_data is capped at 64 bytes and a label can be longer than the
 * budget, so the label itself is never embedded. A list index would be
 * smaller still but goes stale the moment the list changes — tapping an
 * older message could then act on the wrong mailbox, which is a data-loss
 * bug. A hash is stable and self-invalidating: if it no longer resolves,
 * the mailbox is genuinely gone.
 */
export function labelToken(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 8);
}

/** Resolves a token back to a live label, or null if it is stale. */
export function resolveToken(token: string, labels: string[]): string | null {
  return labels.find((l) => labelToken(l) === token) ?? null;
}

export function encodeAction(action: CallbackAction): string {
  switch (action.kind) {
    case 'menu': return 'm';
    case 'add': return 'a';
    case 'list': return 'l';
    case 'status': return 's';
    case 'cancel': return 'c';
    case 'remove-pick': return 'rp';
    case 'test-pick': return 'tp';
    case 'type-host': return 'xh';
    case 'type-port': return 'xp';
    case 'remove': return `r:${action.token}`;
    case 'remove-confirm': return `rc:${action.token}`;
    case 'test': return `t:${action.token}`;
    case 'host': return `h:${action.value}`;
    case 'port': return `p:${action.value}`;
  }
}

export function decodeAction(data: string): CallbackAction | null {
  switch (data) {
    case 'm': return { kind: 'menu' };
    case 'a': return { kind: 'add' };
    case 'l': return { kind: 'list' };
    case 's': return { kind: 'status' };
    case 'c': return { kind: 'cancel' };
    case 'rp': return { kind: 'remove-pick' };
    case 'tp': return { kind: 'test-pick' };
    case 'xh': return { kind: 'type-host' };
    case 'xp': return { kind: 'type-port' };
    default: break;
  }

  const sep = data.indexOf(':');
  if (sep <= 0) return null;
  const prefix = data.slice(0, sep);
  const value = data.slice(sep + 1);
  if (value.length === 0) return null;

  switch (prefix) {
    case 'r': return { kind: 'remove', token: value };
    case 'rc': return { kind: 'remove-confirm', token: value };
    case 't': return { kind: 'test', token: value };
    case 'h': return { kind: 'host', value };
    case 'p': {
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
      return { kind: 'port', value: port };
    }
    default: return null;
  }
}

const btn = (text: string, action: CallbackAction) => ({
  text,
  callback_data: encodeAction(action),
});

export function menuKeyboard(): InlineKeyboard {
  return [
    [btn('➕ Add mailbox', { kind: 'add' })],
    [btn('📋 List', { kind: 'list' }), btn('📊 Status', { kind: 'status' })],
    [btn('🗑 Remove', { kind: 'remove-pick' }), btn('🔌 Test', { kind: 'test-pick' })],
  ];
}

export function mailboxKeyboard(labels: string[], target: 'remove' | 'test'): InlineKeyboard {
  const rows: InlineKeyboard = labels.map((label) => [
    btn(label, target === 'remove'
      ? { kind: 'remove', token: labelToken(label) }
      : { kind: 'test', token: labelToken(label) }),
  ]);
  rows.push([btn('← Back', { kind: 'menu' })]);
  return rows;
}

export function confirmRemoveKeyboard(token: string): InlineKeyboard {
  return [[
    btn('✅ Yes, remove', { kind: 'remove-confirm', token }),
    btn('✖️ Cancel', { kind: 'cancel' }),
  ]];
}

/** The two fields most prone to typos get quick-picks. */
export function hostPickKeyboard(): InlineKeyboard {
  return [
    [btn('Hostinger', { kind: 'host', value: 'imap.hostinger.com' }),
     btn('Gmail', { kind: 'host', value: 'imap.gmail.com' })],
    [btn('Outlook', { kind: 'host', value: 'outlook.office365.com' }),
     btn('iCloud', { kind: 'host', value: 'imap.mail.me.com' })],
    [btn('Type it myself…', { kind: 'type-host' })],
    [btn('✖️ Cancel', { kind: 'cancel' })],
  ];
}

export function portPickKeyboard(): InlineKeyboard {
  return [
    [btn('993 (standard)', { kind: 'port', value: 993 })],
    [btn('Type it myself…', { kind: 'type-port' })],
    [btn('✖️ Cancel', { kind: 'cancel' })],
  ];
}

export function cancelKeyboard(): InlineKeyboard {
  return [[btn('✖️ Cancel', { kind: 'cancel' })]];
}

export function backKeyboard(): InlineKeyboard {
  return [[btn('← Back', { kind: 'menu' })]];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/keyboards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/keyboards.ts test/keyboards.test.ts
git commit -m "feat: callback data encoding and inline keyboard builders"
```

---

### Task 3: Wizard conversation states

**Files:**
- Modify: `src/telegram/conversation.ts`
- Test: `test/conversation.test.ts`

**Interfaces:**
- Consumes: the existing `Pending` union and `Conversations` class.
- Produces: `Pending` gains four variants. The existing `password` and `remove-confirm` variants are UNCHANGED — the typed `/add` still sets `password` directly and its 37 tests must keep passing.
  - `{ kind: 'wizard-label'; expiresAt: number }`
  - `{ kind: 'wizard-host'; label: string; expiresAt: number }`
  - `{ kind: 'wizard-port'; label: string; host: string; expiresAt: number }`
  - `{ kind: 'wizard-username'; label: string; host: string; port: number; expiresAt: number }`
  - `const WIZARD_TTL_MS = PASSWORD_TTL_MS`

After the username step the wizard sets the EXISTING `password` variant, so the final
step — probe, delete the password message, persist, start the watcher — is shared with the
typed path rather than duplicated.

- [ ] **Step 1: Write the failing test**

Append to `test/conversation.test.ts`:

```ts
import { WIZARD_TTL_MS } from '../src/telegram/conversation.js';

describe('wizard states', () => {
  it('stores and returns a label step', () => {
    const c = new Conversations();
    c.set(1, { kind: 'wizard-label', expiresAt: NOW + WIZARD_TTL_MS });
    expect(c.take(1, NOW)).toEqual({ kind: 'wizard-label', expiresAt: NOW + WIZARD_TTL_MS });
  });

  it('carries collected fields forward through the steps', () => {
    const c = new Conversations();
    c.set(1, { kind: 'wizard-port', label: 'Work', host: 'imap.x.com', expiresAt: NOW + WIZARD_TTL_MS });
    expect(c.take(1, NOW)).toMatchObject({ kind: 'wizard-port', label: 'Work', host: 'imap.x.com' });

    c.set(1, { kind: 'wizard-username', label: 'Work', host: 'imap.x.com', port: 993, expiresAt: NOW + WIZARD_TTL_MS });
    expect(c.take(1, NOW)).toMatchObject({ kind: 'wizard-username', port: 993 });
  });

  it('expires a wizard step like any other pending state', () => {
    const c = new Conversations();
    c.set(1, { kind: 'wizard-host', label: 'Work', expiresAt: NOW - 1 });
    expect(c.take(1, NOW)).toBeNull();
    expect(c.size()).toBe(0);
  });

  it('replacing a wizard step with the password step keeps one entry', () => {
    const c = new Conversations();
    c.set(1, { kind: 'wizard-username', label: 'Work', host: 'h', port: 993, expiresAt: NOW + WIZARD_TTL_MS });
    c.set(1, { kind: 'password', label: 'Work', host: 'h', port: 993, username: 'u', expiresAt: NOW + WIZARD_TTL_MS });
    expect(c.take(1, NOW)).toMatchObject({ kind: 'password', username: 'u' });
    expect(c.size()).toBe(0);
  });

  it('WIZARD_TTL_MS matches the password prompt TTL', () => {
    expect(WIZARD_TTL_MS).toBe(PASSWORD_TTL_MS);
  });
});
```

Ensure `PASSWORD_TTL_MS` is imported at the top of that test file — it already is.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conversation.test.ts`
Expected: FAIL — `WIZARD_TTL_MS` is not exported.

- [ ] **Step 3: Extend `src/telegram/conversation.ts`**

Add below the existing TTL constants:

```ts
/**
 * Wizard steps expire on the same clock as the password prompt. The reason
 * is identical: an abandoned flow must not make the bot treat an unrelated
 * later message as a field value.
 */
export const WIZARD_TTL_MS = PASSWORD_TTL_MS;
```

Extend the `Pending` union with the four wizard variants, leaving `password` and
`remove-confirm` exactly as they are:

```ts
export type Pending =
  | {
      kind: 'password';
      label: string;
      host: string;
      port: number;
      username: string;
      expiresAt: number;
    }
  | { kind: 'remove-confirm'; label: string; expiresAt: number }
  | { kind: 'wizard-label'; expiresAt: number }
  | { kind: 'wizard-host'; label: string; expiresAt: number }
  | { kind: 'wizard-port'; label: string; host: string; expiresAt: number }
  | {
      kind: 'wizard-username';
      label: string;
      host: string;
      port: number;
      expiresAt: number;
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/conversation.test.ts test/commands.test.ts`
Expected: PASS — including all 37 command tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/conversation.ts test/conversation.test.ts
git commit -m "feat: wizard conversation states alongside the existing two"
```

---

### Task 4: Receiver support for callback queries

**Files:**
- Modify: `src/telegram/receiver.ts`
- Test: `test/receiver.test.ts`

**Interfaces:**
- Consumes: the existing `TelegramUpdate`, `TelegramMessage`, `isValidUpdate`, `runReceiver`.
- Produces:
  - `type TelegramCallbackQuery = { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }`
  - `TelegramUpdate` gains `callback_query?: TelegramCallbackQuery`

- [ ] **Step 1: Write the failing test**

Append to `test/receiver.test.ts`:

```ts
describe('callback queries', () => {
  function cbUpdate(id: number, data: string): TelegramUpdate {
    return {
      update_id: id,
      callback_query: {
        id: `cbq-${id}`,
        from: { id: 42 },
        data,
        message: { message_id: id * 10, chat: { id: 42 } },
      },
    };
  }

  it('forwards a callback-only update to the handler', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : okUpdates([cbUpdate(1, 'm')])) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async (u) => {
      if (u.callback_query?.data !== undefined) seen.push(u.callback_query.data);
    });
    expect(seen).toEqual(['m']);
  });

  it('advances the offset past a callback-only update', async () => {
    const urls: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      urls.push(url);
      poll += 1;
      return okUpdates(poll === 1 ? [cbUpdate(9, 'm')] : []);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 3, async () => {});
    expect(urls[1]).toContain('offset=10');
  });

  it('skips a callback query with no id rather than forwarding it', async () => {
    const seen: unknown[] = [];
    const bad = { update_id: 1, callback_query: { from: { id: 42 }, data: 'm' } };
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : okUpdates([bad as unknown as TelegramUpdate])) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async (u) => { seen.push(u); });
    expect(seen).toHaveLength(0);
  });

  it('still forwards ordinary message updates', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : okUpdates([update(1, '/list')])) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async (u) => { seen.push(u.message?.text ?? ''); });
    expect(seen).toEqual(['/list']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/receiver.test.ts`
Expected: FAIL — the callback-only update is rejected by `isValidUpdate` and never forwarded.

- [ ] **Step 3: Extend `src/telegram/receiver.ts`**

Add the type and widen the update:

```ts
export type TelegramCallbackQuery = {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};
```

In `isValidUpdate`, keep the existing `update_id` integer check and add: if
`callback_query` is present it must be an object with a non-empty string `id`. An update
carrying neither a usable `message` nor a usable `callback_query` is still forwarded — the
command and callback handlers each ignore what they do not recognise, and dropping it here
would silently swallow future update types.

```ts
function isValidCallbackQuery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const cb = value as { id?: unknown };
  return typeof cb.id === 'string' && cb.id.length > 0;
}
```

and inside `isValidUpdate`, after the `update_id` check:

```ts
  if (update.callback_query !== undefined && !isValidCallbackQuery(update.callback_query)) {
    return false;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/receiver.test.ts`
Expected: PASS, including every pre-existing receiver test.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/receiver.ts test/receiver.test.ts
git commit -m "feat: receiver accepts callback query updates"
```

---

### Task 5: Callback dispatcher — gate, menu, list, status

**Files:**
- Create: `src/telegram/callbacks.ts`
- Test: `test/callbacks.test.ts`

**Interfaces:**
- Consumes: `TelegramUpdate`/`TelegramCallbackQuery` from `receiver.js`; `decodeAction`, `menuKeyboard`, `backKeyboard`, `mailboxKeyboard`, `resolveToken` from `keyboards.js`; `InlineKeyboard` from `sender.js`; `MailboxStore`, `SeenStore`, `WatcherRegistry`, `Conversations`, `ProbeResult`, `Account`.
- Produces:
  - `type CallbackDeps = { operatorChatId: string; mailboxes: MailboxStore; seen: Pick<SeenStore,'purgeAccount'>; registry: WatcherRegistry; conversations: Conversations; probe: (a: Account) => Promise<ProbeResult>; answer: (callbackQueryId: string, text?: string) => Promise<boolean>; edit: (messageId: number, html: string, keyboard?: InlineKeyboard) => Promise<boolean>; reply: (html: string, keyboard?: InlineKeyboard) => Promise<void>; now: () => number }`
  - `function handleCallback(update: TelegramUpdate, deps: CallbackDeps): Promise<void>`
  - `function renderMenu(deps: CallbackDeps, messageId?: number): Promise<void>`

`edit` returning `false` means Telegram refused (message older than 48 hours); every caller
falls back to `reply`.

Tasks 6 and 7 extend this same file with the wizard and the remove/test flows.

- [ ] **Step 1: Write the failing test**

Create `test/callbacks.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleCallback, type CallbackDeps } from '../src/telegram/callbacks.js';
import { Conversations } from '../src/telegram/conversation.js';
import { encodeAction, labelToken } from '../src/telegram/keyboards.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
import type { Account } from '../src/types.js';

const OPERATOR = 42;
const NOW = 1_000_000;

function tap(data: string, chatId = OPERATOR, messageId = 5): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      from: { id: chatId },
      data,
      message: { message_id: messageId, chat: { id: chatId } },
    },
  };
}

function makeDeps(overrides: Partial<CallbackDeps> = {}) {
  const stored = new Map<string, Account>();
  const running = new Set<string>();
  const answers: [string, string | undefined][] = [];
  const edits: string[] = [];
  const replies: string[] = [];
  const probes: string[] = [];

  const deps: CallbackDeps = {
    operatorChatId: String(OPERATOR),
    mailboxes: {
      add: (a: Account) => { stored.set(a.label, a); },
      list: () => [...stored.values()].map((a) => ({
        label: a.label, host: a.host, port: a.port, username: a.user,
      })),
      get: (l: string) => stored.get(l) ?? null,
      labels: () => [...stored.keys()],
      remove: (l: string) => stored.delete(l),
    } as unknown as CallbackDeps['mailboxes'],
    seen: { purgeAccount: vi.fn(() => 2) },
    registry: {
      add: async (a: Account) => { running.add(a.label); },
      remove: async (l: string) => running.delete(l),
      has: (l: string) => running.has(l),
      states: () => [...running].map((l) => ({ label: l, state: 'ok' as const })),
      size: () => running.size,
    } as unknown as CallbackDeps['registry'],
    conversations: new Conversations(),
    probe: async (a: Account) => { probes.push(a.label); return { ok: true, folders: 4 }; },
    answer: async (id: string, text?: string) => { answers.push([id, text]); return true; },
    edit: async (_id: number, html: string) => { edits.push(html); return true; },
    reply: async (html: string) => { replies.push(html); },
    now: () => NOW,
    ...overrides,
  };
  return { deps, answers, edits, replies, stored, running, probes };
}

describe('authorization', () => {
  it('ignores a callback from any other chat entirely', async () => {
    const { deps, answers, edits, replies } = makeDeps();
    await handleCallback(tap('m', 999), deps);
    expect(answers).toEqual([]);
    expect(edits).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('touches nothing for an unauthorized chat — no probe, no store write', async () => {
    const { deps, probes, stored } = makeDeps();
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: 'x' }), 999), deps);
    expect(probes).toEqual([]);
    expect(stored.size).toBe(0);
  });

  it('ignores an update with no callback_query', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback({ update_id: 1 }, deps);
    expect(answers).toEqual([]);
  });
});

describe('answering', () => {
  it('answers the callback query on a normal action', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback(tap('m'), deps);
    expect(answers.map((a) => a[0])).toEqual(['cbq-1']);
  });

  it('answers even when the action is unrecognised', async () => {
    const { deps, answers } = makeDeps();
    await handleCallback(tap('zzz'), deps);
    expect(answers.map((a) => a[0])).toEqual(['cbq-1']);
  });

  it('answers even when the handler throws', async () => {
    const { deps, answers } = makeDeps({
      edit: async () => { throw new Error('boom'); },
      reply: async () => { throw new Error('boom'); },
    });
    await expect(handleCallback(tap('m'), deps)).resolves.toBeUndefined();
    expect(answers.map((a) => a[0])).toEqual(['cbq-1']);
  });
});

describe('menu, list and status', () => {
  it('renders the menu on a menu tap', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('m'), deps);
    expect(edits[0]).toMatch(/mailbox/i);
  });

  it('falls back to a reply when editing is refused', async () => {
    const { deps, replies } = makeDeps({ edit: async () => false });
    await handleCallback(tap('m'), deps);
    expect(replies).toHaveLength(1);
  });

  it('list reports emptiness', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('l'), deps);
    expect(edits[0]).toMatch(/no mailboxes/i);
  });

  it('list masks the password', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u@x', pass: 'hunter2', secure: true });
    await handleCallback(tap('l'), deps);
    expect(edits[0]).toContain('Work');
    expect(edits[0]).not.toContain('hunter2');
  });

  it('status reports idle when nothing is watched', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('s'), deps);
    expect(edits[0]).toMatch(/no mailboxes/i);
  });

  it('status lists a watched mailbox and its state', async () => {
    const { deps, edits } = makeDeps();
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('s'), deps);
    expect(edits[0]).toContain('Work');
    expect(edits[0]).toContain('ok');
  });

  it('remove-pick with no mailboxes says so instead of showing an empty keyboard', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('rp'), deps);
    expect(edits[0]).toMatch(/no mailboxes/i);
  });

  it('remove-pick lists the mailboxes', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('rp'), deps);
    expect(edits[0]).toMatch(/which mailbox/i);
  });

  it('escapes HTML in a mailbox label', async () => {
    const { deps, edits } = makeDeps();
    deps.mailboxes.add({ label: 'A<b>X', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleCallback(tap('l'), deps);
    expect(edits[0]).toContain('&lt;b&gt;');
    expect(edits[0]).not.toContain('<b>X');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/callbacks.test.ts`
Expected: FAIL — cannot resolve `../src/telegram/callbacks.js`.

- [ ] **Step 3: Implement `src/telegram/callbacks.ts`**

```ts
import {
  backKeyboard, decodeAction, mailboxKeyboard, menuKeyboard,
  type CallbackAction,
} from './keyboards.js';
import type { InlineKeyboard } from './sender.js';
import type { TelegramUpdate } from './receiver.js';
import type { Conversations } from './conversation.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';
import { escapeHtml } from '../mail/format.js';

export type CallbackDeps = {
  operatorChatId: string;
  mailboxes: MailboxStore;
  seen: Pick<SeenStore, 'purgeAccount'>;
  registry: WatcherRegistry;
  conversations: Conversations;
  probe: (account: Account) => Promise<ProbeResult>;
  answer: (callbackQueryId: string, text?: string) => Promise<boolean>;
  edit: (messageId: number, html: string, keyboard?: InlineKeyboard) => Promise<boolean>;
  reply: (html: string, keyboard?: InlineKeyboard) => Promise<void>;
  now: () => number;
};

const MENU_TEXT = '📬 <b>Mailboxes</b>\nChoose an action.';

/**
 * Renders content into the tapped message, falling back to a new message.
 *
 * Telegram refuses to edit messages older than 48 hours, so without the
 * fallback a button tapped on a day-old menu would silently do nothing.
 */
async function show(
  deps: CallbackDeps,
  messageId: number | undefined,
  html: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  if (messageId !== undefined && (await deps.edit(messageId, html, keyboard))) return;
  await deps.reply(html, keyboard);
}

export async function renderMenu(deps: CallbackDeps, messageId?: number): Promise<void> {
  await show(deps, messageId, MENU_TEXT, menuKeyboard());
}

/**
 * Entry point for every button tap.
 *
 * The operator-chat gate runs before ANY parsing and before the callback is
 * answered — an unauthorized chat gets nothing at all, because even an error
 * reply confirms to a prober that the bot is live.
 */
export async function handleCallback(update: TelegramUpdate, deps: CallbackDeps): Promise<void> {
  const query = update.callback_query;
  if (query === undefined) return;

  const chatId = query.message?.chat?.id;
  if (chatId === undefined || String(chatId) !== deps.operatorChatId) return;

  const messageId = query.message?.message_id;
  try {
    const action = query.data === undefined ? null : decodeAction(query.data);
    if (action === null) {
      await renderMenu(deps, messageId);
      return;
    }
    await dispatch(action, deps, messageId);
  } catch (err) {
    console.error(`[telegram] callback failed: ${errorText(err)}`);
  } finally {
    // Must happen on every path, including a throw, or the operator's client
    // shows a spinner on the button until it times out.
    await deps.answer(query.id).catch(() => false);
  }
}

async function dispatch(
  action: CallbackAction,
  deps: CallbackDeps,
  messageId: number | undefined
): Promise<void> {
  switch (action.kind) {
    case 'menu':
      return renderMenu(deps, messageId);
    case 'list':
      return showList(deps, messageId);
    case 'status':
      return showStatus(deps, messageId);
    case 'remove-pick':
      return showPicker(deps, messageId, 'remove');
    case 'test-pick':
      return showPicker(deps, messageId, 'test');
    default:
      // Wizard, remove and test actions are added in later tasks.
      return renderMenu(deps, messageId);
  }
}

async function showList(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  const boxes = deps.mailboxes.list();
  if (boxes.length === 0) {
    return show(deps, messageId, 'No mailboxes configured yet.', menuKeyboard());
  }
  const lines = boxes.map(
    (b) => `• <b>${escapeHtml(b.label)}</b> — ${escapeHtml(b.username)} @ ${escapeHtml(b.host)}:${b.port} — ••••••••`
  );
  return show(deps, messageId, `Configured mailboxes:\n${lines.join('\n')}`, backKeyboard());
}

async function showStatus(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  const states = deps.registry.states();
  if (states.length === 0) {
    return show(deps, messageId, 'No mailboxes are being watched.', menuKeyboard());
  }
  const lines = states.map((s) => `• <b>${escapeHtml(s.label)}</b> — ${escapeHtml(s.state)}`);
  return show(deps, messageId, `Watcher status:\n${lines.join('\n')}`, backKeyboard());
}

async function showPicker(
  deps: CallbackDeps,
  messageId: number | undefined,
  target: 'remove' | 'test'
): Promise<void> {
  const labels = deps.mailboxes.labels();
  if (labels.length === 0) {
    return show(deps, messageId, 'No mailboxes configured yet.', menuKeyboard());
  }
  const verb = target === 'remove' ? 'remove' : 'test';
  return show(deps, messageId, `Which mailbox would you like to ${verb}?`, mailboxKeyboard(labels, target));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

Do NOT import `resolveToken` yet — nothing in this task uses it, and an unused import is
dead code a reviewer will rightly flag. Task 7 adds it when the remove and test flows need
it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/callbacks.test.ts && npm test`
Expected: PASS, including all 37 command tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/callbacks.ts test/callbacks.test.ts
git commit -m "feat: callback dispatcher with operator gate, menu, list and status"
```

---

### Task 6: The add wizard

**Files:**
- Modify: `src/telegram/callbacks.ts`, `src/telegram/commands.ts`
- Test: `test/callbacks.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3 and 5.
- Produces:
  - `function startWizard(deps: CallbackDeps, messageId: number | undefined): Promise<void>` — exported for testing
  - `function handleWizardMessage(text: string, messageId: number, deps: CommandDeps): Promise<boolean>` in `commands.ts` — returns `true` if the message was consumed as a wizard step

The wizard's typed steps arrive as ordinary messages, so `commands.ts` must consult the
wizard states before its command dispatch. Its existing `password` handling is untouched.

- [ ] **Step 1: Write the failing tests**

Append to `test/callbacks.test.ts`:

```ts
describe('add wizard', () => {
  it('add starts the wizard and asks for a label', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('a'), deps);
    expect(edits[0]).toMatch(/label/i);
    expect(deps.conversations.size()).toBe(1);
  });

  it('cancel clears the pending wizard and returns to the menu', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap('a'), deps);
    await handleCallback(tap('c'), deps);
    expect(deps.conversations.size()).toBe(0);
    expect(edits.at(-1)).toMatch(/mailbox/i);
  });

  it('a host quick-pick advances to the port step', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleCallback(tap(encodeAction({ kind: 'host', value: 'imap.hostinger.com' })), deps);
    expect(edits.at(-1)).toMatch(/port/i);
  });

  it('a port quick-pick advances to the username step', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'Work', host: 'h', expiresAt: NOW + 60_000 });
    await handleCallback(tap(encodeAction({ kind: 'port', value: 993 })), deps);
    expect(edits.at(-1)).toMatch(/username|email/i);
  });

  it('type-host asks the operator to type a host and keeps the wizard pending', async () => {
    const { deps, edits } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleCallback(tap('xh'), deps);
    expect(edits.at(-1)).toMatch(/host/i);
    expect(deps.conversations.size()).toBe(1);
  });

  it('a host pick with no wizard pending returns to the menu instead of guessing', async () => {
    const { deps, edits } = makeDeps();
    await handleCallback(tap(encodeAction({ kind: 'host', value: 'imap.x.com' })), deps);
    expect(edits.at(-1)).toMatch(/mailbox/i);
    expect(deps.conversations.size()).toBe(0);
  });
});
```

Append to `test/commands.test.ts`:

```ts
describe('wizard typed steps', () => {
  it('a typed label advances to the host step', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-label', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('Work'), deps);
    expect(replies.at(-1)).toMatch(/host/i);
  });

  it('a typed host advances to the port step', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-host', label: 'Work', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('imap.example.com'), deps);
    expect(replies.at(-1)).toMatch(/port/i);
  });

  it('an invalid typed port re-prompts without advancing', async () => {
    const { deps, replies } = makeDeps();
    deps.conversations.set(OPERATOR, { kind: 'wizard-port', label: 'W', host: 'h', expiresAt: NOW + 60_000 });
    await handleUpdate(msg('not-a-port'), deps);
    expect(replies.at(-1)).toMatch(/port/i);
    expect(deps.conversations.size()).toBe(1);
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/callbacks.test.ts test/commands.test.ts`
Expected: FAIL — wizard steps are not handled.

- [ ] **Step 3: Implement the wizard in `src/telegram/callbacks.ts`**

Add these imports at the top: `cancelKeyboard`, `hostPickKeyboard`, `portPickKeyboard` from
`./keyboards.js`, and `WIZARD_TTL_MS` from `./conversation.js`.

Add to `dispatch`'s switch, replacing the `default` branch:

```ts
    case 'add':
      return startWizard(deps, messageId);
    case 'cancel':
      deps.conversations.clear(Number(deps.operatorChatId));
      return renderMenu(deps, messageId);
    case 'host':
      return applyHost(deps, messageId, action.value);
    case 'port':
      return applyPort(deps, messageId, action.value);
    case 'type-host':
      return show(deps, messageId, 'Send the IMAP host as your next message.', cancelKeyboard());
    case 'type-port':
      return show(deps, messageId, 'Send the port number as your next message.', cancelKeyboard());
    default:
      // remove and test actions are added in Task 7.
      return renderMenu(deps, messageId);
```

And these functions:

```ts
export async function startWizard(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'wizard-label',
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(
    deps,
    messageId,
    'What should this mailbox be called? Send a short label, e.g. <b>Work</b>.',
    cancelKeyboard()
  );
}

/**
 * A quick-pick only makes sense while its step is pending. Tapping a stale
 * host button from an old message must not invent a wizard out of nothing.
 */
async function applyHost(
  deps: CallbackDeps,
  messageId: number | undefined,
  host: string
): Promise<void> {
  const pending = deps.conversations.take(Number(deps.operatorChatId), deps.now());
  if (pending === null || pending.kind !== 'wizard-host') {
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'wizard-port',
    label: pending.label,
    host,
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(deps, messageId, `Host: <b>${escapeHtml(host)}</b>\n\nWhich port?`, portPickKeyboard());
}

async function applyPort(
  deps: CallbackDeps,
  messageId: number | undefined,
  port: number
): Promise<void> {
  const pending = deps.conversations.take(Number(deps.operatorChatId), deps.now());
  if (pending === null || pending.kind !== 'wizard-port') {
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'wizard-username',
    label: pending.label,
    host: pending.host,
    port,
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(
    deps,
    messageId,
    `Port: <b>${port}</b>\n\nSend the username or email address for this mailbox.`,
    cancelKeyboard()
  );
}
```

- [ ] **Step 4: Handle the typed wizard steps in `src/telegram/commands.ts`**

Import `WIZARD_TTL_MS` from `./conversation.js`. In `handleUpdate`, the existing pending
branch reads:

```ts
  const pending = deps.conversations.take(message.chat.id, deps.now());
  if (pending !== null && !text.startsWith('/')) {
```

Extend that branch to route wizard kinds before the existing `password` and
`remove-confirm` handling:

```ts
    if (pending.kind === 'wizard-label') {
      deps.conversations.set(message.chat.id, {
        kind: 'wizard-host', label: text, expiresAt: deps.now() + WIZARD_TTL_MS,
      });
      return deps.reply('Which IMAP host? Send it as your next message, e.g. imap.hostinger.com');
    }
    if (pending.kind === 'wizard-host') {
      deps.conversations.set(message.chat.id, {
        kind: 'wizard-port', label: pending.label, host: text, expiresAt: deps.now() + WIZARD_TTL_MS,
      });
      return deps.reply('Which port? Send a number — 993 is standard.');
    }
    if (pending.kind === 'wizard-port') {
      const port = Number(text);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        // Re-prompt WITHOUT advancing, so a typo cannot skip a field.
        deps.conversations.set(message.chat.id, {
          kind: 'wizard-port', label: pending.label, host: pending.host,
          expiresAt: deps.now() + WIZARD_TTL_MS,
        });
        return deps.reply('That is not a valid port. Send a number between 1 and 65535.');
      }
      deps.conversations.set(message.chat.id, {
        kind: 'wizard-username', label: pending.label, host: pending.host, port,
        expiresAt: deps.now() + WIZARD_TTL_MS,
      });
      return deps.reply('Send the username or email address for this mailbox.');
    }
    if (pending.kind === 'wizard-username') {
      deps.conversations.set(message.chat.id, {
        kind: 'password', label: pending.label, host: pending.host, port: pending.port,
        username: text, expiresAt: deps.now() + PASSWORD_TTL_MS,
      });
      return deps.reply(
        'Now send the password. I will delete your message as soon as I have read it.'
      );
    }
```

**Do NOT import `escapeHtml` into `commands.ts`.** It is deliberately absent. The command
path's `reply` adapter in `src/index.ts` escapes the entire reply string at the send
boundary, so escaping here as well would double-escape and show the operator `&amp;lt;`.
That split is why the invalid-port message above echoes nothing back — it states the rule
rather than quoting the bad input.

`callbacks.ts` is the opposite: it emits intentional `<b>` markup, so it escapes each
interpolated field itself and its `reply`/`edit` adapters do not escape. Getting these two
conventions backwards is the most likely way to break this feature.

The existing `password` and `remove-confirm` branches follow unchanged, so the wizard
terminates in the same probe-delete-persist-start path as the typed command.

Also extend the cancellation notice: the existing code announces a cancelled
`password prompt` or `removal confirmation` when a `/`-command arrives mid-flow. Add the
wizard kinds so the notice reads `mailbox setup` for any `wizard-*` kind.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all 37 original command tests plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/callbacks.ts src/telegram/commands.ts test/callbacks.test.ts test/commands.test.ts
git commit -m "feat: guided add wizard across buttons and typed steps"
```

---

### Task 7: Remove and test flows, plus wiring

**Files:**
- Modify: `src/telegram/callbacks.ts`, `src/index.ts`, `src/telegram/commands.ts`
- Test: `test/callbacks.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `main()` routes `callback_query` updates to `handleCallback`; `/start` and `/menu` render the menu.

- [ ] **Step 1: Write the failing tests**

Append to `test/callbacks.test.ts`:

```ts
describe('remove and test', () => {
  function seed(deps: CallbackDeps, label: string) {
    deps.mailboxes.add({ label, host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
  }

  it('picking a mailbox asks for confirmation and deletes nothing yet', async () => {
    const { deps, edits, stored } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'remove', token: labelToken('Work') })), deps);
    expect(edits.at(-1)).toMatch(/remove/i);
    expect(stored.size).toBe(1);
  });

  it('confirming removes the mailbox, stops the watcher and purges state', async () => {
    const { deps, stored, running, edits } = makeDeps();
    seed(deps, 'Work');
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });

    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Work') })), deps);

    expect(stored.size).toBe(0);
    expect(running.has('Work')).toBe(false);
    expect(deps.seen.purgeAccount).toHaveBeenCalledWith('Work');
    expect(edits.at(-1)).toMatch(/removed/i);
  });

  it('a stale remove token reports the mailbox is gone and acts on nothing', async () => {
    const { deps, stored, edits } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Deleted') })), deps);
    expect(stored.size).toBe(1);
    expect(edits.at(-1)).toMatch(/no longer exists|not found/i);
  });

  it('a stale token never purges another account', async () => {
    const { deps } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'remove-confirm', token: labelToken('Ghost') })), deps);
    expect(deps.seen.purgeAccount).not.toHaveBeenCalled();
  });

  it('test runs the probe and reports success', async () => {
    const { deps, edits, probes } = makeDeps();
    seed(deps, 'Work');
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Work') })), deps);
    expect(probes).toEqual(['Work']);
    expect(edits.at(-1)).toMatch(/4 folders/i);
  });

  it('test reports a failure without leaking the password', async () => {
    const { deps, edits } = makeDeps({
      probe: async () => ({ ok: false, reason: 'login failed for u with hunter2' }),
    });
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'hunter2', secure: true });
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Work') })), deps);
    expect(edits.at(-1)).not.toContain('hunter2');
  });

  it('a stale test token reports the mailbox is gone', async () => {
    const { deps, edits, probes } = makeDeps();
    await handleCallback(tap(encodeAction({ kind: 'test', token: labelToken('Ghost') })), deps);
    expect(probes).toEqual([]);
    expect(edits.at(-1)).toMatch(/no longer exists|not found/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/callbacks.test.ts`
Expected: FAIL — remove and test actions fall through to the menu.

- [ ] **Step 3: Implement the flows in `src/telegram/callbacks.ts`**

Add `confirmRemoveKeyboard` and `resolveToken` to the existing `./keyboards.js` import. Replace `dispatch`'s `default`
branch with explicit cases:

```ts
    case 'remove':
      return confirmRemove(deps, messageId, action.token);
    case 'remove-confirm':
      return doRemove(deps, messageId, action.token);
    case 'test':
      return doTest(deps, messageId, action.token);
```

and add:

```ts
/**
 * Resolves a token to a live label, or reports a stale button.
 *
 * Telegram keeps old messages tappable indefinitely, so a button referring
 * to a since-deleted mailbox is normal, not exceptional. A callback is never
 * treated as evidence that its target still exists.
 */
async function resolveOrReport(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<string | null> {
  const label = resolveToken(token, deps.mailboxes.labels());
  if (label === null) {
    await show(deps, messageId, 'That mailbox no longer exists.', menuKeyboard());
  }
  return label;
}

async function confirmRemove(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<void> {
  const label = await resolveOrReport(deps, messageId, token);
  if (label === null) return;
  await show(
    deps,
    messageId,
    `Remove <b>${escapeHtml(label)}</b>?\nThis deletes its credentials and notification history.`,
    confirmRemoveKeyboard(token)
  );
}

async function doRemove(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<void> {
  const label = await resolveOrReport(deps, messageId, token);
  if (label === null) return;

  await deps.registry.remove(label);
  deps.mailboxes.remove(label);
  deps.seen.purgeAccount(label);
  await show(deps, messageId, `Removed <b>${escapeHtml(label)}</b> and stopped watching it.`, menuKeyboard());
}

async function doTest(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<void> {
  const label = await resolveOrReport(deps, messageId, token);
  if (label === null) return;

  let account: Account | null;
  try {
    account = deps.mailboxes.get(label);
  } catch (err) {
    // Decryption can fail if MASTER_KEY changed. Report it — silence here is
    // indistinguishable from "mail stopped arriving".
    return show(deps, messageId, `Could not read <b>${escapeHtml(label)}</b>: ${escapeHtml(errorText(err))}`, backKeyboard());
  }
  if (account === null) {
    return show(deps, messageId, 'That mailbox no longer exists.', menuKeyboard());
  }

  const result = await deps.probe(account);
  const text = result.ok
    ? `<b>${escapeHtml(label)}</b> connected — ${result.folders} folders.`
    : `<b>${escapeHtml(label)}</b> failed to connect.\n\n${escapeHtml(result.reason)}`;
  await show(deps, messageId, text, backKeyboard());
}
```

- [ ] **Step 4: Add menu entry points to `src/telegram/commands.ts`**

The `/start` and `/help` case currently replies with `USAGE`. Change it to also render the
menu, and add `/menu` as an alias. Since `commands.ts` has no keyboard-aware reply, add an
optional `menu?: () => Promise<void>` to `CommandDeps` and call it when present:

```ts
    case '/start':
    case '/help':
    case '/menu':
      if (deps.menu !== undefined) await deps.menu();
      return deps.reply(USAGE);
```

Declare it in `CommandDeps` as `menu?: () => Promise<void>;`. It is optional so all 37
existing tests, which do not supply it, keep passing unchanged.

- [ ] **Step 5: Wire it in `src/index.ts`**

Import `handleCallback`, `renderMenu` and `type CallbackDeps` from
`./telegram/callbacks.js`. Build the callback deps alongside the existing command deps,
reusing the same store, registry, conversations and probe, and add:

```ts
      const callbackDeps: CallbackDeps = {
        operatorChatId,
        mailboxes,
        seen: store,
        registry,
        conversations,
        probe: probeMailbox,
        answer: (id, text) => sender.answerCallbackQuery(id, text),
        edit: (messageId, html, keyboard) =>
          sender.editMessageText(operatorChatId, messageId, html, keyboard),
        reply: async (html, keyboard) => {
          await sender.send(html, keyboard);
        },
        now: () => Date.now(),
      };
```

Note the callback deps take **already-escaped HTML** — `callbacks.ts` escapes each
interpolated field itself, because it emits intentional `<b>` markup. This differs from the
command path, whose `reply` escapes the whole string. Do not double-escape here.

Then route updates:

```ts
        onUpdate: async (update) => {
          if (update.callback_query !== undefined) {
            return handleCallback(update, callbackDeps);
          }
          return handleUpdate(update, commandDeps);
        },
```

and pass `menu: () => renderMenu(callbackDeps)` into the command deps.

- [ ] **Step 6: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all tests pass, `tsc` clean.

- [ ] **Step 7: Update the README**

In the "Adding a mailbox" section, lead with the button flow and keep the typed commands as
an alternative:

```markdown
### Adding a mailbox

Message the bot `/start` and use the buttons — Add walks you through it one field at a
time, with quick-picks for common IMAP hosts and the standard port. The password is asked
for separately and deleted from the chat as soon as it is read.

Typed commands still work if you prefer them: `/add <label> <host> <port> <username>`,
`/list`, `/remove <label>`, `/status`, `/test <label>`.
```

- [ ] **Step 8: Commit**

```bash
git add src/telegram/callbacks.ts src/telegram/commands.ts src/index.ts test/callbacks.test.ts README.md
git commit -m "feat: remove and test button flows, menu entry points and wiring"
```

---

## Verification checklist

- [ ] Every action reachable by a typed command is reachable by tapping
- [ ] Adding a mailbox types only label, username and password
- [ ] A callback from another chat produces no reply and no side effect
- [ ] `answerCallbackQuery` is called on every path, including throws
- [ ] A stale token reports clearly and acts on nothing
- [ ] All 37 original command tests pass unchanged
- [ ] `npm test` and `npm run build` are clean
