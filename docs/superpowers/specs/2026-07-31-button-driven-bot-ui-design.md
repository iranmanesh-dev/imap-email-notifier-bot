# Button-Driven Bot UI — Design

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-07-31-runtime-mailbox-config-design.md`

## Purpose

Replace typed bot commands with an inline-keyboard menu and a guided step-by-step
wizard, so managing mailboxes from a phone requires tapping rather than composing
command lines.

## Success criteria

1. Every action reachable today by a typed command is reachable by tapping.
2. Adding a mailbox requires typing only the label, username, and password — host and
   port are tappable for common providers.
3. A callback from any chat other than the operator's is ignored entirely, with no reply
   and no side effect.
4. Every button tap answers its callback query, so the client never shows a stuck spinner.
5. A stale button — one referencing a mailbox that no longer exists — reports that clearly
   and never acts on the stale reference.
6. All existing typed commands continue to work, and their tests pass unchanged.

## Scope decisions

Settled explicitly during design:

- **Full guided wizard**, not merely tappable selection lists. The worst typing today is
  `/add <label> <host> <port> <username>`, so a wizard that eliminates it is the point.
- **Typed commands are kept.** The command router exists, is well tested, and costs
  nothing to retain. It is also the fallback if a callback flow ever wedges.
- **Telegram has no form inputs.** Buttons carry choices; every actual value still arrives
  as a text message. This is a platform constraint, not a design preference.

## Architecture

| Module | Change |
|---|---|
| `src/telegram/receiver.ts` | Accept `callback_query` updates; it currently validates and forwards `message` only |
| `src/telegram/sender.ts` | Add `reply_markup` support, `answerCallbackQuery`, `editMessageText` |
| `src/telegram/conversation.ts` | `Pending` gains wizard variants alongside its existing two |
| `src/telegram/keyboards.ts` | **New.** Builds inline keyboards; encodes and decodes callback data |
| `src/telegram/callbacks.ts` | **New.** Dispatches taps, mirroring `commands.ts`'s shape and deps |

`commands.ts` is unchanged except where it shares the conversation state machine.

**The two flows share one state store, not one state shape.** `Pending` today has exactly
two variants — `password` and `remove-confirm` — and the typed `/add` sets `password`
directly, in one step, because it already collected label/host/port/username from the
command line. The wizard adds new variants for its intermediate steps. Both write to the
same per-chat `Conversations` map, so starting a wizard cancels a pending typed flow and
vice versa, which is the correct behaviour and already the rule for a `/`-command arriving
mid-prompt. The typed path's variants must not change, or its tests would need rewriting —
which is precisely what the regression gate below exists to catch.

### Callback data encoding

`callback_data` is capped at **64 bytes**, and a mailbox label may exceed what remains
after an action prefix. Three options were considered:

- **List index (`rm:3`)** — rejected. Goes stale the moment the list changes, so a button
  tapped from an older message could remove the wrong mailbox. That is a data-loss bug.
- **Truncated label** — rejected. Ambiguous across similar labels.
- **Short hash of the label (`rm:a1b2c3d4`)** — chosen. The first 8 hex characters of
  `sha256(label)`. Stable across list changes, always fits, and resolved at tap time by
  scanning `labels()`. A token that no longer resolves means the mailbox is gone, and
  saying so is the correct response to a stale button.

Actions with no target (`menu`, `add`, `list`, `status`, `cancel`) use short literals.

## Flows

### Menu

Shown by `/start`, `/menu`, and after any action completes:

```
📬 Mailboxes
[ ➕ Add mailbox           ]
[ 📋 List    ] [ 📊 Status ]
[ 🗑 Remove  ] [ 🔌 Test   ]
```

### Add wizard

One prompt at a time, with Cancel present at every step:

1. **Label** — typed.
2. **Host** — quick-pick buttons for Hostinger, Gmail, Outlook, iCloud, plus
   "Type it myself…".
3. **Port** — `[993 (standard)]` plus "Type it myself…".
4. **Username** — typed.
5. **Password** — typed, in a separate message which the bot deletes immediately on
   receipt.

Host and port are the two fields most prone to typos, which is why they get quick-picks.
After step 5 the existing behaviour applies unchanged: probe first, persist only on
success, then start the watcher.

### Remove and Test

Both render the operator's mailboxes as buttons. Remove then confirms inline with
`[Yes, remove] [Cancel]`, replacing the current "reply with the word yes" step.

### List and Status

Render their existing text output plus a `[← Back]` button.

## Message handling

The wizard **edits the menu message in place** as it advances, so a five-step flow does
not leave five messages in the chat. The password prompt is the exception: it is sent as a
new message so that deleting the operator's reply is unambiguous.

## Security

- **The chat-ID gate must cover callback queries.** The existing gate inspects
  `message.chat.id` only, so callbacks would bypass it entirely. This is a new route into
  the security boundary and must be closed in the same place, before any parsing, with no
  reply to an unauthorised chat.
- A callback carries both `from` and `message.chat`; the gate validates the chat the
  keyboard is attached to.
- Stale buttons are re-validated against current state at tap time. A callback is never
  trusted as evidence that the referenced mailbox still exists.
- The password step's existing guarantees are unchanged: deleted from the chat on receipt,
  never echoed, never logged.

## Error handling

| Failure | Response |
|---|---|
| Any tap, any outcome | `answerCallbackQuery` in a `finally` — otherwise the client spins until it times out |
| Token does not resolve | Toast "that mailbox no longer exists", re-render the menu, take no action |
| `editMessageText` rejected | Telegram refuses to edit messages older than 48 hours — fall back to sending a new message, or a day-old menu silently does nothing |
| Tap arrives mid-wizard | Cancel the pending flow with a notice, reusing the rule already implemented for a `/`-command interrupting a password prompt |
| Invalid port typed | Re-prompt without advancing; Cancel stays available |
| Wizard expiry | The existing 5-minute TTL applies; tapping a stale button re-renders the menu |

## Testing

**Unit:**
- The callback gate rejects a foreign callback **silently and inertly** — asserting no
  probe call and no store write, not merely no reply. Same standard as the command gate.
- Token round-trip: encode/decode, resolution of a live label, and a stale token.
- `answerCallbackQuery` is called on every path, including when the handler throws.
- Each wizard step advances and cancels correctly; an invalid port re-prompts rather than
  advancing.
- The password step still deletes the message and never echoes it.
- `editMessageText` failure falls back to a new message.

**Regression gate:** all 37 existing command tests pass unchanged. That is what proves the
"keep both" decision actually held.

**Integration:** the existing GreenMail suite is unaffected; no new integration coverage is
required, since the wizard terminates in the same probe-and-persist path already covered.

## Out of scope

- Reply keyboards (the persistent keyboard replacement). Inline keyboards only.
- Editing an existing mailbox in place — remove and re-add, as today.
- Pagination of the mailbox list. A single operator with a handful of mailboxes fits in one
  keyboard; revisit if that stops being true.
- Localisation.
