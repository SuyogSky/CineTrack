import { describe, it, expect } from 'vitest';
import { envSchema } from '../src/config/env';

describe('Phase 5: Distinct Production Security Secrets Validation Tests', () => {
  const baseValidProd = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://prod_user:strong_pass@prod-db.internal:5432/cinetrack_prod?sslmode=require',
    CORS_ORIGIN: 'https://cinetrack.example.com',
    JWT_ACCESS_SECRET: '9f83ab2c4e61d85f7a02b4c6e819d3f57a91b2c4e6f80a2b4c6d8e0f2a4b6c8d',
    JWT_REFRESH_SECRET: '3b7c9e1a5f82d4608b1a3c5e7f902b4d6f8a0c2e4f618a3b5c7d9e1f3a5b7c9e',
    CSRF_SECRET: '7a1b3c5e9f02d468ace02468bdf13579bdf02468ace13579bdf02468ace13579',
  };

  it('1. should pass when all three secrets are strong and pairwise distinct', () => {
    const res = envSchema.safeParse(baseValidProd);
    expect(res.success).toBe(true);
  });

  it('2. should reject when access and refresh secrets are identical', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      JWT_REFRESH_SECRET: baseValidProd.JWT_ACCESS_SECRET,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issues = res.error.issues;
      expect(issues.some((i) => i.message.includes('JWT_REFRESH_SECRET must be distinct from JWT_ACCESS_SECRET'))).toBe(true);
    }
  });

  it('3. should reject when access and CSRF secrets are identical', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      CSRF_SECRET: baseValidProd.JWT_ACCESS_SECRET,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issues = res.error.issues;
      expect(issues.some((i) => i.message.includes('CSRF_SECRET must be distinct from JWT_ACCESS_SECRET'))).toBe(true);
    }
  });

  it('4. should reject when refresh and CSRF secrets are identical', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      CSRF_SECRET: baseValidProd.JWT_REFRESH_SECRET,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issues = res.error.issues;
      expect(issues.some((i) => i.message.includes('CSRF_SECRET must be distinct from JWT_REFRESH_SECRET'))).toBe(true);
    }
  });

  it('5. should reject when all three secrets are identical', () => {
    const sameSecret = '9f83ab2c4e61d85f7a02b4c6e819d3f57a91b2c4e6f80a2b4c6d8e0f2a4b6c8d';
    const res = envSchema.safeParse({
      ...baseValidProd,
      JWT_ACCESS_SECRET: sameSecret,
      JWT_REFRESH_SECRET: sameSecret,
      CSRF_SECRET: sameSecret,
    });
    expect(res.success).toBe(false);
  });

  it('6. should reject secrets that differ only through trivial casing or whitespace', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      JWT_REFRESH_SECRET: `  ${baseValidProd.JWT_ACCESS_SECRET.toUpperCase()}  `,
    });
    expect(res.success).toBe(false);
  });

  it('7. should reject weak secret containing forbidden patterns in production', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      JWT_ACCESS_SECRET: 'my_super_secret_password_for_cinetrack_app_production_12345',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes('contains a known weak or placeholder value'))).toBe(true);
    }
  });

  it('8. should reject placeholder secret in production', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      CSRF_SECRET: 'replace_with_a_secure_csrf_secret_32_characters_minimum',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes('contains a known weak or placeholder value'))).toBe(true);
    }
  });

  it('9. should reject missing secret', () => {
    const { JWT_ACCESS_SECRET, ...missingAccess } = baseValidProd;
    const res = envSchema.safeParse(missingAccess);
    expect(res.success).toBe(false);
  });

  it('10. should reject too-short secret (< 32 characters)', () => {
    const res = envSchema.safeParse({
      ...baseValidProd,
      JWT_ACCESS_SECRET: 'short_key_under_32_chars',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes('at least 32 characters'))).toBe(true);
    }
  });

  it('11. should accept valid development configuration with dev defaults', () => {
    const devConfig = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack?schema=public',
      JWT_ACCESS_SECRET: 'cinetrack_dev_access_secret_key_32_chars_min_length_2026!',
      JWT_REFRESH_SECRET: 'cinetrack_dev_refresh_secret_key_32_chars_min_length_2026!',
      CSRF_SECRET: 'cinetrack_dev_csrf_secret_key_32_chars_min_length_2026!',
    };
    const res = envSchema.safeParse(devConfig);
    expect(res.success).toBe(true);
  });

  it('12. should accept valid test configuration with isolated test database', () => {
    const testConfig = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack?schema=public',
      TEST_DATABASE_URL: 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public',
      EXPECTED_TEST_DATABASE_NAME: 'cinetrack_test',
      JWT_ACCESS_SECRET: 'test-access-secret-32-chars-long-min!!',
      JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-long-min!',
      CSRF_SECRET: 'test-csrf-secret-32-chars-long-min!!!!',
    };
    const res = envSchema.safeParse(testConfig);
    expect(res.success).toBe(true);
  });
});
