import { describe, it, expect } from 'vitest';
import { envSchema, validateProductionOrigin } from '../src/config/env';

describe('Phase 7: Hardened Production CORS Validation Tests', () => {
  const baseValidProd = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://prod_user:strong_pass@prod-db.internal:5432/cinetrack_prod?sslmode=require',
    JWT_ACCESS_SECRET: '9f83ab2c4e61d85f7a02b4c6e819d3f57a91b2c4e6f80a2b4c6d8e0f2a4b6c8d',
    JWT_REFRESH_SECRET: '3b7c9e1a5f82d4608b1a3c5e7f902b4d6f8a0c2e4f618a3b5c7d9e1f3a5b7c9e',
    CSRF_SECRET: '7a1b3c5e9f02d468ace02468bdf13579bdf02468ace13579bdf02468ace13579',
  };

  it('1. should accept valid public HTTPS origin', () => {
    const res = validateProductionOrigin('https://cinetrack.example.com');
    expect(res.valid).toBe(true);

    const envRes = envSchema.safeParse({
      ...baseValidProd,
      CORS_ORIGIN: 'https://cinetrack.example.com',
    });
    expect(envRes.success).toBe(true);
  });

  it('2. should reject public HTTP origin in production (insecure scheme)', () => {
    const res = validateProductionOrigin('http://cinetrack.example.com');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/must use HTTPS scheme/i);
  });

  it('3. should reject localhost in production', () => {
    const res = validateProductionOrigin('https://localhost:5173');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/localhost/i);
  });

  it('4. should reject IPv4 loopback address (127.0.0.1 and 127.x.x.x)', () => {
    const res1 = validateProductionOrigin('https://127.0.0.1:5173');
    expect(res1.valid).toBe(false);
    expect(res1.error).toMatch(/IPv4 loopback/i);

    const res2 = validateProductionOrigin('https://127.10.20.30:4000');
    expect(res2.valid).toBe(false);
    expect(res2.error).toMatch(/IPv4 loopback/i);
  });

  it('5. should reject private IPv4 addresses (10.x, 172.16-31.x, 192.168.x)', () => {
    const res10 = validateProductionOrigin('https://10.0.0.5:8080');
    expect(res10.valid).toBe(false);
    expect(res10.error).toMatch(/private IPv4/i);

    const res172 = validateProductionOrigin('https://172.20.1.100:8443');
    expect(res172.valid).toBe(false);
    expect(res172.error).toMatch(/private IPv4/i);

    const res192 = validateProductionOrigin('https://192.168.1.10:3000');
    expect(res192.valid).toBe(false);
    expect(res192.error).toMatch(/private IPv4/i);
  });

  it('6. should reject link-local IPv4 address (169.254.x.x)', () => {
    const res = validateProductionOrigin('https://169.254.169.254');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/link-local/i);
  });

  it('7. should reject IPv6 loopback address (::1 or [::1])', () => {
    const res = validateProductionOrigin('https://[::1]:5173');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/IPv6 loopback/i);
  });

  it('8. should reject private IPv6 addresses (unique local fc00::/7)', () => {
    const res = validateProductionOrigin('https://[fc00::1]:8443');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/private IPv6/i);
  });

  it('9. should reject wildcard origin "*"', () => {
    const res = validateProductionOrigin('*');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Wildcard origin "\*" is strictly forbidden/i);
  });

  it('10. should reject malformed URL', () => {
    const res = validateProductionOrigin('not_a_valid_url_string');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Malformed origin URL/i);
  });

  it('11. should reject origin containing a path', () => {
    const res = validateProductionOrigin('https://cinetrack.example.com/api/v1');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/must not include a path component/i);
  });

  it('12. should reject origin containing a query string', () => {
    const res = validateProductionOrigin('https://cinetrack.example.com?auth=token');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/must not include a query string/i);
  });

  it('13. should accept multiple valid comma-separated origins', () => {
    const envRes = envSchema.safeParse({
      ...baseValidProd,
      CORS_ORIGIN: 'https://cinetrack.example.com, https://admin.cinetrack.example.com, https://preview.cinetrack.example.com:8443',
    });
    expect(envRes.success).toBe(true);
  });

  it('14. should reject multiple origins if any single origin is invalid', () => {
    const envRes = envSchema.safeParse({
      ...baseValidProd,
      CORS_ORIGIN: 'https://cinetrack.example.com, http://insecure.cinetrack.example.com',
    });
    expect(envRes.success).toBe(false);
  });

  it('15. should reject IPv4-mapped IPv6 loopback addresses in dotted and hex formats', () => {
    // Standard dotted-decimal IPv4-mapped loopback
    const resDotted = validateProductionOrigin('https://[::ffff:127.0.0.1]:5173');
    expect(resDotted.valid).toBe(false);
    expect(resDotted.error).toMatch(/IPv4 loopback/i);

    // Canonical hex format generated by WHATWG URL parser (127.0.0.1 = 7f00:1)
    const resHex = validateProductionOrigin('https://[::ffff:7f00:1]:5173');
    expect(resHex.valid).toBe(false);
    expect(resHex.error).toMatch(/IPv4 loopback/i);
  });

  it('16. should reject IPv4-mapped IPv6 private addresses (10.x, 192.168.x)', () => {
    // 10.0.0.1 (hex a00:1)
    const res10Dotted = validateProductionOrigin('https://[::ffff:10.0.0.1]:8080');
    expect(res10Dotted.valid).toBe(false);
    expect(res10Dotted.error).toMatch(/private IPv4/i);

    const res10Hex = validateProductionOrigin('https://[::ffff:a00:1]:8080');
    expect(res10Hex.valid).toBe(false);
    expect(res10Hex.error).toMatch(/private IPv4/i);

    // 192.168.1.1 (hex c0a8:101)
    const res192Dotted = validateProductionOrigin('https://[::ffff:192.168.1.1]:3000');
    expect(res192Dotted.valid).toBe(false);
    expect(res192Dotted.error).toMatch(/private IPv4/i);

    const res192Hex = validateProductionOrigin('https://[::ffff:c0a8:101]:3000');
    expect(res192Hex.valid).toBe(false);
    expect(res192Hex.error).toMatch(/private IPv4/i);
  });

  it('17. should reject Carrier-Grade NAT (CGNAT, RFC 6598) addresses', () => {
    const resCgnat = validateProductionOrigin('https://100.64.0.1:443');
    expect(resCgnat.valid).toBe(false);
    expect(resCgnat.error).toMatch(/Carrier-Grade NAT/i);

    const resCgnatMapped = validateProductionOrigin('https://[::ffff:100.64.0.1]:443');
    expect(resCgnatMapped.valid).toBe(false);
    expect(resCgnatMapped.error).toMatch(/Carrier-Grade NAT/i);
  });

  it('18. should reject multicast and reserved IPv4 addresses', () => {
    const resMulticast = validateProductionOrigin('https://224.0.0.1');
    expect(resMulticast.valid).toBe(false);
    expect(resMulticast.error).toMatch(/multicast IPv4/i);

    const resBroadcast = validateProductionOrigin('https://255.255.255.255');
    expect(resBroadcast.valid).toBe(false);
    expect(resBroadcast.error).toMatch(/reserved\/broadcast IPv4/i);
  });

  it('19. should reject multicast IPv6 addresses', () => {
    const resMulticastIpv6 = validateProductionOrigin('https://[ff02::1]:8443');
    expect(resMulticastIpv6.valid).toBe(false);
    expect(resMulticastIpv6.error).toMatch(/multicast IPv6/i);
  });
});
