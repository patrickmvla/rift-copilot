/**
 * ULID utilities (monotonic) + ergonomic helpers.
 * - id(): monotonic ULID (26 chars, Crockford base32), lexicographically sortable by time.
 * - prefixedId('src'): returns 'src_<ulid>'.
 * - makeId('src'): returns a function to generate typed IDs with the given prefix.
 * - isUlid(s): quick validator for ULID charset/length.
 * - parseUlidTime(s): extract timestamp (Date) from a ULID.
 *
 * No external deps. Uses Web Crypto when available; falls back to Math.random.
 * Safe for both server and client bundles.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10; // 48-bit time -> 10 base32 chars
const RAND_LEN = 16; // 80-bit randomness -> 16 base32 chars
const ID_LEN = TIME_LEN + RAND_LEN; // 26

// Build a fast lookup table for decoding
const CHAR_INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) CHAR_INDEX[ALPHABET[i]] = i;

// Internal monotonic state
let lastTimeMs = -1;
let lastRandom: number[] | null = null;

function hasWebCrypto(): boolean {
  return typeof globalThis !== 'undefined' && !!globalThis.crypto && !!globalThis.crypto.getRandomValues;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  if (hasWebCrypto()) {
    globalThis.crypto.getRandomValues(out);
  } else {
    // Fallback (should rarely happen in modern runtimes)
    for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function encodeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid timestamp for ULID');
  let time = Math.floor(ms);
  let str = '';
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = time % 32;
    str = ALPHABET[mod] + str;
    time = Math.floor(time / 32);
  }
  return str;
}

function randomPart(): number[] {
  // 16 base32 digits -> 80 random bits. We take 16 bytes, mask to 5 bits each (uniform).
  const bytes = randomBytes(RAND_LEN);
  const arr = new Array<number>(RAND_LEN);
  for (let i = 0; i < RAND_LEN; i++) {
    arr[i] = bytes[i] & 31; // 0..31 (uniform because 256 % 32 === 0)
  }
  return arr;
}

function incrementBase32(arr: number[]): void {
  // Increment like a base32 number to ensure monotonicity when time does not increase.
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] < 31) {
      arr[i] += 1;
      return;
    }
    arr[i] = 0;
  }
  // Extremely unlikely overflow (32^16 IDs within 1 ms). If it happens, wrap to zeros.
}

function encodeRandom(arr: number[]): string {
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += ALPHABET[arr[i]];
  }
  return out;
}

/**
 * Returns a lexicographically sortable monotonic ULID.
 * Uses the current time or a provided timestamp (ms).
 */
export function ulid(ms?: number): string {
  const now = Math.max(ms ?? Date.now(), 0);

  // Ensure time never goes backwards (clock skew)
  const time = Math.max(now, lastTimeMs);

  let rand: number[];
  if (time === lastTimeMs && lastRandom) {
    // Same ms: increment randomness for monotonic ordering
    rand = lastRandom.slice();
    incrementBase32(rand);
  } else {
    rand = randomPart();
  }

  lastTimeMs = time;
  lastRandom = rand;

  return encodeTime(time) + encodeRandom(rand);
}

/**
 * Primary ergonomic ID function.
 * Example: const threadId = id(); // ULID
 */
export function id(): string {
  return ulid();
}

/**
 * Generate an ID with a stable, sanitized prefix: "<prefix>_<ulid>"
 * - Prefix is lowercased and stripped to [a-z0-9]+ (dashes/underscores kept).
 * - Throws if the sanitized prefix becomes empty.
 */
export function prefixedId(prefix: string): string {
  const p = sanitizePrefix(prefix);
  if (!p) throw new Error('Invalid prefix for prefixedId');
  return `${p}_${ulid()}`;
}

/**
 * Factory for typed IDs, e.g.:
 *   export const newThreadId = makeId('thrd');
 *   const id = newThreadId();
 */
export function makeId(prefix: string): () => string {
  const p = sanitizePrefix(prefix);
  if (!p) throw new Error('Invalid prefix for makeId');
  return () => `${p}_${ulid()}`;
}

/**
 * Validate a ULID string by charset/length (does not check time/rand semantics).
 */
export function isUlid(s: string): boolean {
  if (typeof s !== 'string' || s.length !== ID_LEN) return false;
  const up = s.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    if (CHAR_INDEX[up[i]] === undefined) return false;
  }
  return true;
}

/**
 * Extract timestamp from ULID (first 10 chars). Returns Date.
 * Throws on invalid input.
 */
export function parseUlidTime(s: string): Date {
  if (!isUlid(s)) throw new Error('Invalid ULID');
  const up = s.toUpperCase();
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = CHAR_INDEX[up[i]];
    // multiply by 32 then add digit
    ms = ms * 32 + v;
  }
  // 48-bit time fits safely in JS number (<= 2^53 - 1)
  return new Date(ms);
}

/**
 * Optionally: extract timestamp in ms without creating a Date.
 */
export function ulidTimestamp(s: string): number {
  if (!isUlid(s)) throw new Error('Invalid ULID');
  const up = s.toUpperCase();
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = CHAR_INDEX[up[i]];
    ms = ms * 32 + v;
  }
  return ms;
}

/**
 * Sanitize and normalize a prefix for prefixed IDs.
 * Keeps [a-z0-9_-], trims, lowercases, collapses multiple separators.
 */
function sanitizePrefix(prefix: string): string {
  return String(prefix)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')    // normalize invalid chars to '-'
    .replace(/[-_]{2,}/g, '-')        // collapse repeats
    .replace(/^[-_]+|[-_]+$/g, '');   // trim separators
}