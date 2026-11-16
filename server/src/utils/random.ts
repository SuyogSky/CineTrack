import crypto from 'crypto';

export function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function selectRandomElement<T>(
  items: T[],
  rng: () => number = Math.random
): T | null {
  if (!items || items.length === 0) {
    return null;
  }
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)];
}
