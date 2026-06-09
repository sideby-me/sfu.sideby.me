// RED→GREEN for the coturn HMAC iceServers mint (TURN-02 / TURN-03).
//
// The credential formula is the coturn `use-auth-secret` REST API scheme:
//   username   = `<unix-expiry>:<participantId>`
//   credential = base64(HMAC-SHA1(static-auth-secret, username))
// These tests pin the clock (vi.setSystemTime) and the secret (vi.hoisted env) so
// the credential is fully deterministic and independently recomputable here.
import { createHmac } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts reads env ONCE at module load and requireEnv()s MEDIASOUP_ANNOUNCED_IP,
// so the env must be set BEFORE any import resolves — vi.hoisted runs first.
const ENV = vi.hoisted(() => ({
  secret: 'test-static-auth-secret',
  host: 'turn.sideby.me',
  ttl: 3600,
}));

vi.hoisted(() => {
  process.env.MEDIASOUP_ANNOUNCED_IP = '203.0.113.10';
  process.env.TURN_STATIC_AUTH_SECRET = 'test-static-auth-secret';
  process.env.TURN_PUBLIC_HOST = 'turn.sideby.me';
  process.env.TURN_CRED_TTL_SEC = '3600';
});

const { buildIceServers } = await import('./ice-servers.js');

// A fixed wall-clock so expiry (= now + ttl) is deterministic across the suite.
const FIXED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const EXPECTED_EXPIRY = Math.floor(FIXED_NOW_MS / 1000) + ENV.ttl;

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.setSystemTime(FIXED_NOW_MS);
});

describe('buildIceServers (coturn HMAC mint)', () => {
  it('mints a deterministic base64(HMAC-SHA1(secret, "<expiry>:<id>")) credential', () => {
    const servers = buildIceServers('participant-abc');

    const expectedUsername = `${EXPECTED_EXPIRY}:participant-abc`;
    const expectedCredential = createHmac('sha1', ENV.secret).update(expectedUsername).digest('base64');

    const turnUdp = servers.find(s => typeof s.urls === 'string' && s.urls.startsWith('turn:') && s.urls.includes('transport=udp'));
    expect(turnUdp).toBeDefined();
    expect(turnUdp!.username).toBe(expectedUsername);
    expect(turnUdp!.credential).toBe(expectedCredential);
  });

  it('is stable: the same (secret, username) always yields the same credential', () => {
    const a = buildIceServers('same-id');
    const b = buildIceServers('same-id');
    const credA = a.find(s => s.credential)!.credential;
    const credB = b.find(s => s.credential)!.credential;
    expect(credA).toBe(credB);
    expect(credA).toBeTruthy();
  });

  it('is secret-sensitive: a different secret yields a different credential', () => {
    const username = `${EXPECTED_EXPIRY}:secret-test`;
    const withRealSecret = buildIceServers('secret-test').find(s => s.credential)!.credential;
    const withOtherSecret = createHmac('sha1', 'a-completely-different-secret').update(username).digest('base64');
    expect(withRealSecret).not.toBe(withOtherSecret);
    // Sanity: the real one recomputes to the same value with the real secret.
    expect(withRealSecret).toBe(createHmac('sha1', ENV.secret).update(username).digest('base64'));
  });

  it('returns stun + turn(udp) + turn(tcp) + turns(tcp) all on :443', () => {
    const urls = buildIceServers('p').map(s => s.urls as string);

    expect(urls.some(u => u.startsWith(`stun:${ENV.host}:443`))).toBe(true);
    expect(urls.some(u => u.startsWith(`turn:${ENV.host}:443`) && u.includes('transport=udp'))).toBe(true);
    expect(urls.some(u => u.startsWith(`turn:${ENV.host}:443`) && u.includes('transport=tcp'))).toBe(true);
    expect(urls.some(u => u.startsWith(`turns:${ENV.host}:443`) && u.includes('transport=tcp'))).toBe(true);

    // Every url carries the :443 coturn port.
    for (const u of urls) {
      expect(u).toContain(':443');
    }
  });

  it('encodes a future expiry (= now + ttl) into the username', () => {
    const username = buildIceServers('expiry-id').find(s => s.username)!.username!;
    const [expiryStr] = username.split(':');
    expect(Number(expiryStr)).toBe(EXPECTED_EXPIRY);
    expect(Number(expiryStr)).toBeGreaterThan(Math.floor(FIXED_NOW_MS / 1000));
  });
});
