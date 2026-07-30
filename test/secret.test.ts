import { describe, it, expect } from 'vitest';
import { deriveKey, encryptSecret, decryptSecret } from '../src/crypto/secret.js';

const KEY = deriveKey('a'.repeat(32));
const OTHER = deriveKey('b'.repeat(32));

describe('secret', () => {
  it('round-trips a password', () => {
    const blob = encryptSecret('hunter2', KEY);
    expect(decryptSecret(blob, KEY)).toBe('hunter2');
  });

  it('never stores the plaintext in the blob', () => {
    const blob = encryptSecret('hunter2', KEY);
    expect(blob.toString('utf8')).not.toContain('hunter2');
    expect(blob.toString('hex')).not.toContain(Buffer.from('hunter2').toString('hex'));
  });

  it('uses a fresh IV per call, so identical inputs differ', () => {
    expect(encryptSecret('same', KEY).equals(encryptSecret('same', KEY))).toBe(false);
  });

  it('fails with the wrong key rather than returning garbage', () => {
    const blob = encryptSecret('hunter2', KEY);
    expect(() => decryptSecret(blob, OTHER)).toThrow();
  });

  it('fails when the ciphertext is tampered with (GCM auth)', () => {
    const blob = encryptSecret('hunter2', KEY);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it('fails when the auth tag is tampered with', () => {
    const blob = encryptSecret('hunter2', KEY);
    blob[13] ^= 0xff;
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it('fails when the IV is tampered with', () => {
    const blob = encryptSecret('hunter2', KEY);
    blob[0] ^= 0xff;
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it('rejects a truncated blob instead of reading out of bounds', () => {
    expect(() => decryptSecret(Buffer.alloc(8), KEY)).toThrow(/too short/i);
  });

  it('rejects a blob with zero ciphertext (exactly IV + tag)', () => {
    expect(() => decryptSecret(Buffer.alloc(28), KEY)).toThrow(/too short/i);
  });

  it('rejects an empty plaintext at encrypt time', () => {
    expect(() => encryptSecret('', KEY)).toThrow(/empty/i);
  });

  it('derives the same key from the same master key', () => {
    expect(deriveKey('x'.repeat(40)).equals(deriveKey('x'.repeat(40)))).toBe(true);
  });

  it('derives different keys from different master keys', () => {
    expect(deriveKey('x'.repeat(40)).equals(deriveKey('y'.repeat(40)))).toBe(false);
  });

  it('handles unicode and long passwords', () => {
    const pw = 'pässwörd🔐' + 'z'.repeat(500);
    expect(decryptSecret(encryptSecret(pw, KEY), KEY)).toBe(pw);
  });
});
