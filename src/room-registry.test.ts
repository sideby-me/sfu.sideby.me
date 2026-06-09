// Room registry — lazy Router create, opaque IDs, participant cap, grace-timer reclaim.
//
// mediasoup is mocked at the Router boundary: getNextWorker() returns a fake worker
// whose createRouter() yields a fake Router carrying a close() spy. No real C++
// worker is spawned, so these run fast and deterministically (RESEARCH: mock at the
// router boundary). Timers are faked so the grace window is driven explicitly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// config.ts reads MEDIASOUP_ANNOUNCED_IP (hard-required) at module load. vitest
// hoists `vi.mock` AND static imports above top-level statements, so set the env in
// a vi.hoisted() block — which runs before any import resolves — and pin the cap +
// grace window so the assertions below are stable regardless of the host env.
vi.hoisted(() => {
  process.env.MEDIASOUP_ANNOUNCED_IP = '203.0.113.10';
  process.env.PARTICIPANT_CAP = '8';
  process.env.RECONNECT_GRACE_MS = '30000';
});

// Each fake router gets its own close spy so we can assert close-on-reclaim.
const createdRouters: Array<{ close: ReturnType<typeof vi.fn> }> = [];
const createRouter = vi.fn(async () => {
  const router = { close: vi.fn() };
  createdRouters.push(router);
  return router;
});
const fakeWorker = { createRouter };

// Mock the workers module at the router boundary — getNextWorker() hands back our
// fake worker; mediaCodecs is passed through to createRouter but its content is
// irrelevant to the registry's lifecycle behavior.
vi.mock('./mediasoup/workers.js', () => ({
  getNextWorker: () => fakeWorker,
}));

// Import AFTER the mock + env are in place (ESM hoists vi.mock, but be explicit).
import {
  ensureRoom,
  getRoom,
  deleteRoom,
  canAdmit,
  assertCanAdmit,
  handlePeerLeave,
} from './room-registry.js';
import { config } from './config.js';

// A minimal fake Peer — the registry only cares about Map size for the cap, so any
// object keyed by participantId works.
function fakePeer(id: string) {
  return { participantId: id } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  createRouter.mockClear();
  createdRouters.length = 0;
});

afterEach(() => {
  // Drain the registry so each test starts clean.
  for (const id of ['r1', 'r2', 'cap-room', 'reclaim-room', 'rejoin-room']) {
    deleteRoom(id);
  }
  vi.useRealTimers();
});

describe('ensureRoom — lazy create-once (idempotent)', () => {
  it('creates exactly one Router on first call and returns the SAME room thereafter', async () => {
    const first = await ensureRoom('r1');
    const second = await ensureRoom('r1');

    expect(first).toBe(second);
    expect(createRouter).toHaveBeenCalledTimes(1);
    expect(first.mediaRoomId).toBe('r1');
    expect(first.peers.size).toBe(0);
  });

  it('creates a distinct Router per distinct mediaRoomId', async () => {
    await ensureRoom('r1');
    await ensureRoom('r2');
    expect(createRouter).toHaveBeenCalledTimes(2);
    expect(getRoom('r1')).not.toBe(getRoom('r2'));
  });
});

describe('participant cap (SFU-11, default 8)', () => {
  it('admits while under the cap and rejects once peers.size equals the cap', async () => {
    const room = await ensureRoom('cap-room');
    for (let i = 0; i < config.participantCap; i++) {
      expect(canAdmit(room)).toBe(true);
      room.peers.set(`p${i}`, fakePeer(`p${i}`));
    }
    // Now full.
    expect(room.peers.size).toBe(config.participantCap);
    expect(canAdmit(room)).toBe(false);
    expect(() => assertCanAdmit(room)).toThrow();
  });
});

describe('grace-timer reclaim (SFU-09 — no idle-router leak)', () => {
  it('arms a reclaim timer on last-peer-leave that closes the Router and deletes the entry', async () => {
    const room = await ensureRoom('reclaim-room');
    room.peers.set('p0', fakePeer('p0'));
    const router = createdRouters[0]!;

    // Last peer leaves → reclaim armed but not yet fired.
    room.peers.delete('p0');
    handlePeerLeave(room);
    expect(router.close).not.toHaveBeenCalled();
    expect(getRoom('reclaim-room')).toBe(room);

    // Fire the grace window.
    vi.advanceTimersByTime(config.reconnectGraceMs);
    expect(router.close).toHaveBeenCalledTimes(1);
    expect(getRoom('reclaim-room')).toBeUndefined();
  });

  it('does NOT reclaim while peers remain', async () => {
    const room = await ensureRoom('reclaim-room');
    room.peers.set('p0', fakePeer('p0'));
    room.peers.set('p1', fakePeer('p1'));
    const router = createdRouters[0]!;

    room.peers.delete('p0');
    handlePeerLeave(room); // still one peer left
    vi.advanceTimersByTime(config.reconnectGraceMs * 2);
    expect(router.close).not.toHaveBeenCalled();
    expect(getRoom('reclaim-room')).toBe(room);
  });
});

describe('rejoin cancels reclaim', () => {
  it('a rejoin (ensureRoom) before the grace timer fires cancels reclaim and reuses the Router', async () => {
    const room = await ensureRoom('rejoin-room');
    room.peers.set('p0', fakePeer('p0'));
    const router = createdRouters[0]!;

    // Last peer leaves → reclaim armed.
    room.peers.delete('p0');
    handlePeerLeave(room);

    // Rejoin BEFORE the timer fires.
    vi.advanceTimersByTime(config.reconnectGraceMs - 1);
    const rejoined = await ensureRoom('rejoin-room');
    expect(rejoined).toBe(room); // same room — Router NOT recreated
    expect(createRouter).toHaveBeenCalledTimes(1);

    // Advance past where the original timer would have fired — must NOT close.
    vi.advanceTimersByTime(config.reconnectGraceMs);
    expect(router.close).not.toHaveBeenCalled();
    expect(getRoom('rejoin-room')).toBe(room);
  });
});
