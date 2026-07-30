import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Fixed application salt. Single-key deployment, so a constant salt is fine. */
const SALT = Buffer.from('imap-email-notifier-bot/v1');
const INFO = Buffer.from('mailbox-password');

/** Derives a 32-byte AES key from an arbitrary-length master key. */
export function deriveKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), SALT, INFO, 32));
}

/** Returns `iv ‖ authTag ‖ ciphertext`. */
export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  if (plaintext.length === 0) {
    throw new Error('cannot encrypt an empty secret');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Reverses encryptSecret. Throws if the key is wrong or the blob was
 * tampered with — GCM authenticates, so this never returns garbage that
 * could be sent to an IMAP server as a password.
 */
export function decryptSecret(blob: Buffer, key: Buffer): string {
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted secret is too short to be valid');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
