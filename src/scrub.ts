/**
 * Redacts a secret from arbitrary text before it reaches a log line or a bot
 * reply.
 *
 * IMAP servers and libraries sometimes echo the credentials they were given
 * — a rejected `LOGIN` can come back with the raw command attached — so
 * scrubbing at the output boundary is the only reliable place to do it.
 *
 * Shared rather than duplicated per module on purpose: that premise cannot
 * be selectively true. `probeMailbox` and `AccountWatcher` use the same
 * credentials against the same server, and the watcher logs on every
 * connection and sweep failure, which makes it the higher-volume channel of
 * the two.
 */
export function scrubSecret(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('***');
}
