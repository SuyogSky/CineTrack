import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/utils/password';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
} from '../../src/utils/jwt';
import {
  generateShareToken,
  selectRandomElement,
} from '../../src/utils/random';
import {
  registerSchema,
  loginSchema,
} from '../../src/validators/auth.validator';
import {
  createCollectionSchema,
  updateCollectionMovieSchema,
  moveMovieSchema,
} from '../../src/validators/collection.validator';
import { movieSearchQuerySchema } from '../../src/validators/movie.validator';

describe('Unit Tests: Authentication & Password Utilities', () => {
  it('should hash and verify passwords using Argon2id', async () => {
    const password = 'SuperSecurePassword2026!';
    const hash = await hashPassword(password);
    expect(hash).toContain('$argon2id$');

    const isValid = await verifyPassword(hash, password);
    expect(isValid).toBe(true);

    const isInvalid = await verifyPassword(hash, 'WrongPassword!');
    expect(isInvalid).toBe(false);
  });

  it('should generate and verify JWT access and refresh tokens with mandatory sessionId', () => {
    const payload = {
      id: 'uuid-1234-5678',
      username: 'cinephile',
      email: 'cinephile@example.com',
    };
    const validSessionId = '12345678-1234-4234-8234-123456789abc';

    const token = generateAccessToken(payload, validSessionId);
    expect(typeof token).toBe('string');

    const decoded = verifyAccessToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(payload.id);
    expect(decoded?.username).toBe(payload.username);
    expect(decoded?.sessionId).toBe(validSessionId);

    // Rejects missing or invalid sessionId
    expect(() => generateAccessToken(payload, '' as any)).toThrow(/Invalid or missing sessionId/);
    expect(() => generateAccessToken(payload, 'not-a-uuid' as any)).toThrow(/Invalid or missing sessionId/);

    const refreshToken = generateRefreshToken(payload, validSessionId);
    const decodedRefresh = verifyRefreshToken(refreshToken);
    expect(decodedRefresh).not.toBeNull();
    expect(decodedRefresh?.sessionId).toBe(validSessionId);
  });

  it('should hash session tokens deterministically with SHA-256', () => {
    const token = 'sample-secret-token-string';
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });
});

describe('Unit Tests: Random Utilities & Deterministic RNG', () => {
  it('should generate unguessable base64url share tokens', () => {
    const token1 = generateShareToken();
    const token2 = generateShareToken();
    expect(token1).not.toBe(token2);
    expect(token1.length).toBeGreaterThanOrEqual(30);
  });

  it('should select random element from array with injectable RNG', () => {
    const movies = ['Inception', 'Interstellar', 'The Matrix', 'Dune'];

    // RNG returning 0 -> index 0 (Inception)
    const first = selectRandomElement(movies, () => 0.0);
    expect(first).toBe('Inception');

    // RNG returning 0.75 -> index 3 (Dune)
    const last = selectRandomElement(movies, () => 0.75);
    expect(last).toBe('Dune');

    // Empty array returns null
    expect(selectRandomElement([])).toBeNull();
  });
});

describe('Unit Tests: Zod Validation Schemas', () => {
  it('should validate valid registration inputs', () => {
    const valid = {
      username: 'john_doe',
      email: 'John@Example.COM',
      password: 'SecurePassword123',
      confirmPassword: 'SecurePassword123',
    };
    const parsed = registerSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe('john@example.com');
    }
  });

  it('should reject invalid usernames, weak passwords, and mismatched passwords', () => {
    const invalidUsername = registerSchema.safeParse({
      username: 'bad name with spaces!',
      email: 'valid@example.com',
      password: 'Password123',
      confirmPassword: 'Password123',
    });
    expect(invalidUsername.success).toBe(false);

    const weakPassword = registerSchema.safeParse({
      username: 'validuser',
      email: 'valid@example.com',
      password: 'alllowercase',
      confirmPassword: 'alllowercase',
    });
    expect(weakPassword.success).toBe(false);

    const mismatch = registerSchema.safeParse({
      username: 'validuser',
      email: 'valid@example.com',
      password: 'Password123',
      confirmPassword: 'DifferentPassword123',
    });
    expect(mismatch.success).toBe(false);
  });

  it('should validate login schema inputs', () => {
    expect(loginSchema.safeParse({ identifier: 'user', password: 'pwd' }).success).toBe(true);
    expect(loginSchema.safeParse({ identifier: '', password: 'pwd' }).success).toBe(false);
    expect(loginSchema.safeParse({ identifier: 'user', password: '' }).success).toBe(false);
  });

  it('should validate movie search queries', () => {
    expect(movieSearchQuerySchema.safeParse({ q: 'Batman' }).success).toBe(true);
    expect(movieSearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(movieSearchQuerySchema.safeParse({ q: 'a'.repeat(101) }).success).toBe(false);
  });

  it('should validate collection and move movie schemas', () => {
    expect(createCollectionSchema.safeParse({ title: 'My SciFi' }).success).toBe(true);
    expect(createCollectionSchema.safeParse({ title: '' }).success).toBe(false);

    expect(updateCollectionMovieSchema.safeParse({ status: 'WATCHED', note: 'Great' }).success).toBe(true);
    expect(updateCollectionMovieSchema.safeParse({ status: 'INVALID_STATUS' }).success).toBe(false);

    expect(moveMovieSchema.safeParse({ destinationCollectionId: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
    expect(moveMovieSchema.safeParse({ destinationCollectionId: 'not-a-uuid' }).success).toBe(false);
  });
});
