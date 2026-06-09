// RED→GREEN for the SFU server-to-server admin + health/readiness surface (SFU-10).
//
// The admin surface is the deploy/LB readiness gate and the S2S room-provisioning
// entry. It mirrors lens's `X-*-Secret` auth and sync's Zod-validate-then-act POST.
// These tests drive the raw-`http` request handler directly (no live socket) so the
// secret gate (401), bad body (400), create-room success (201), and the worker-pool
// readiness assertion (200/503) are all proven deterministically.
//
// HARD INVARIANT (SFU-02 / Pitfall 11): the admin surface carries OPAQUE IDs only.
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// config.ts reads env ONCE at module load and requireEnv()s MEDIASOUP_ANNOUNCED_IP,
// so the env must be set BEFORE any import resolves — vi.hoisted runs first. The
// admin secret is set so the X-Sfu-Secret gate is active in these tests.
vi.hoisted(() => {
  process.env.MEDIASOUP_ANNOUNCED_IP = '203.0.113.10';
  process.env.SFU_ADMIN_SECRET = 'test-admin-secret';
  process.env.TURN_STATIC_AUTH_SECRET = 'test-static-auth-secret';
  process.env.TURN_PUBLIC_HOST = 'turn.sideby.me';
});

const SECRET = 'test-admin-secret';

// Worker-pool readiness is driven through getWorkers() — mock it so we can flip the
// pool between "up" (≥1 worker) and "down" (empty) without spawning mediasoup.
const workersState = vi.hoisted(() => ({ count: 1 }));
vi.mock('../mediasoup/workers.js', () => ({
  getWorkers: () => Array.from({ length: workersState.count }, (_, i) => ({ index: i })),
}));

// ensureRoom is mocked to return an opaque room descriptor — the admin must NEVER
// touch product data, so the mock asserts it is only ever called with an opaque id.
const ensureRoomMock = vi.hoisted(() => vi.fn());
vi.mock('../room-registry.js', () => ({
  ensureRoom: ensureRoomMock,
}));

const { createAdminHandler } = await import('./admin.js');

// ── Minimal http req/res doubles ─────────────────────────────────────────────
interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function makeReq(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = headers;
  // Emit the body on next tick so the handler's `req.on('data'/'end')` is wired first.
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes(): MockRes & { setHeader: (k: string, v: string) => void; end: (c?: string) => void } {
  const res: MockRes = { statusCode: 200, headers: {}, body: '', ended: false };
  return {
    ...res,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      this.ended = true;
    },
  } as MockRes & { setHeader: (k: string, v: string) => void; end: (c?: string) => void };
}

async function call(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const handler = createAdminHandler();
  const req = makeReq(method, url, headers, body);
  const res = makeRes();
  await handler(req as never, res as never);
  return res;
}

beforeAll(() => {
  ensureRoomMock.mockResolvedValue({ mediaRoomId: 'opaque-room-123' });
});

afterEach(() => {
  workersState.count = 1;
  ensureRoomMock.mockClear();
  ensureRoomMock.mockResolvedValue({ mediaRoomId: 'opaque-room-123' });
});

describe('admin POST /rooms — secret gate (T-01-15)', () => {
  it('returns 401 without a valid X-Sfu-Secret header', async () => {
    const res = await call('POST', '/rooms', {}, { mediaRoomId: 'opaque-room-123' });
    expect(res.statusCode).toBe(401);
    expect(ensureRoomMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the secret is wrong', async () => {
    const res = await call('POST', '/rooms', { 'x-sfu-secret': 'nope' }, { mediaRoomId: 'opaque-room-123' });
    expect(res.statusCode).toBe(401);
    expect(ensureRoomMock).not.toHaveBeenCalled();
  });
});

describe('admin POST /rooms — body validation (T-01-16)', () => {
  it('returns 400 with the first Zod issue message on a malformed body', async () => {
    const res = await call('POST', '/rooms', { 'x-sfu-secret': SECRET }, { notAField: true });
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body) as { error: string };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length).toBeGreaterThan(0);
    expect(ensureRoomMock).not.toHaveBeenCalled();
  });
});

describe('admin POST /rooms — create-room success', () => {
  it('returns 201 and an opaque room descriptor, calling ensureRoom with the opaque mediaRoomId', async () => {
    const res = await call('POST', '/rooms', { 'x-sfu-secret': SECRET }, { mediaRoomId: 'opaque-room-123' });
    expect(res.statusCode).toBe(201);
    expect(ensureRoomMock).toHaveBeenCalledWith('opaque-room-123');
    const parsed = JSON.parse(res.body) as { mediaRoomId: string };
    expect(parsed.mediaRoomId).toBe('opaque-room-123');
  });
});

describe('admin GET /readiness — worker-pool assertion', () => {
  it('returns 200 when the worker pool is up', async () => {
    workersState.count = 2;
    const res = await call('GET', '/readiness', {});
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 when the worker pool is down', async () => {
    workersState.count = 0;
    const res = await call('GET', '/readiness', {});
    expect(res.statusCode).toBe(503);
  });
});

describe('admin GET /health', () => {
  it('returns 200 JSON { status: ok, service: sfu }', async () => {
    const res = await call('GET', '/health', {});
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { status: string; service: string };
    expect(parsed.status).toBe('ok');
    expect(parsed.service).toBe('sfu');
  });
});
