import crypto from 'crypto';

export function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Cryptographically secure, unbiased selection from an array of elements.
 * Uses crypto.randomInt to eliminate modulo bias. If a custom rng is provided (e.g. for testing),
 * it uses the provided rng function.
 */
export function selectRandomElement<T>(
  items: T[],
  rng?: () => number
): T | null {
  if (!items || items.length === 0) {
    return null;
  }
  if (rng) {
    const index = Math.floor(rng() * items.length);
    return items[Math.min(index, items.length - 1)];
  }
  // Node.js crypto.randomInt generates uniform random integers in [0, items.length) without modulo bias
  const index = crypto.randomInt(0, items.length);
  return items[index];
}
