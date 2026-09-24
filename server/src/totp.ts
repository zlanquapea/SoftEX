import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 time-based one-time passwords for multifactor authentication (§5.7, §9). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20));

export function totp(secret: string, time = Date.now(), step = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

/** Accept the current code and one step either side to allow for clock drift. */
export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  const cleaned = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  return [-1, 0, 1].some((drift) => {
    const expected = Buffer.from(totp(secret, time + drift * 30_000));
    return timingSafeEqual(expected, Buffer.from(cleaned));
  });
}

export const otpauthUrl = (secret: string, email: string) =>
  `otpauth://totp/SoftEX:${encodeURIComponent(email)}?secret=${secret}&issuer=SoftEX&algorithm=SHA1&digits=6&period=30`;
