// Room registry — the single source of truth for live conferences (SFU-09, SFU-11).
//
// A module-level Map<mediaRoomId, MediaRoom>. ensureRoom() lazily creates exactly
// one Router per opaque mediaRoomId (pinned to a round-robin worker) and is
// idempotent on repeat calls. The cap is enforced server-side. mediasoup has NO
// garbage collection, so an empty room's Router is explicitly closed after a grace
// window — a rejoin within the window cancels the reclaim and reuses the Router.
//
// HARD INVARIANT (Pitfall 11): only opaque IDs live here — no roomId/userId/etc.
import { config } from './config.js';
import { getNextWorker } from './mediasoup/workers.js';
import { mediaCodecs } from './mediasoup/codecs.js';
import type { MediaRoom } from './mediasoup/room.js';

const registry = new Map<string, MediaRoom>();

/**
 * Get the live room for an opaque mediaRoomId, or undefined if none exists.
 * Does NOT create — see ensureRoom for lazy creation.
 */
export function getRoom(mediaRoomId: string): MediaRoom | undefined {
  return registry.get(mediaRoomId);
}

/**
 * Lazily create (or return) the room for `mediaRoomId`. On first call a Router is
 * created via getNextWorker().createRouter({ mediaCodecs }), pinning the conference
 * to one worker (round-robin). On repeat calls the SAME room is returned and any
 * pending reclaim timer is cancelled (a rejoin cancels reclaim — the Router is NOT
 * recreated).
 */
export async function ensureRoom(mediaRoomId: string): Promise<MediaRoom> {
  const existing = registry.get(mediaRoomId);
  if (existing) {
    // Rejoin: cancel a pending reclaim so the Router is kept alive.
    if (existing.reclaimTimer) {
      clearTimeout(existing.reclaimTimer);
      existing.reclaimTimer = undefined;
    }
    return existing;
  }

  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs });

  const room: MediaRoom = {
    mediaRoomId,
    router,
    peers: new Map(),
    reclaimTimer: undefined,
  };
  registry.set(mediaRoomId, room);
  return room;
}

/**
 * Whether the room can admit another participant. Server-side participant cap
 * (SFU-11, default config.participantCap = 8): full once peers.size hits the cap.
 */
export function canAdmit(room: MediaRoom): boolean {
  return room.peers.size < config.participantCap;
}

/**
 * Cap guard — throws when the room is at capacity. Signaling handlers (Plan 03)
 * call this before admitting a peer so over-cap joins are rejected at the boundary.
 */
export function assertCanAdmit(room: MediaRoom): void {
  if (!canAdmit(room)) {
    throw new Error(`media room ${room.mediaRoomId} is at capacity (${config.participantCap})`);
  }
}

/**
 * Call after a peer has been removed from room.peers. If the room is now empty,
 * arm the grace-timer reclaim: when it fires, close the Router (mediasoup has no
 * GC) and delete the registry entry (SFU-09). A rejoin via ensureRoom() before the
 * timer fires cancels it.
 */
export function handlePeerLeave(room: MediaRoom): void {
  if (room.peers.size > 0) {
    return;
  }
  // Don't stack timers if one is already pending.
  if (room.reclaimTimer) {
    return;
  }
  room.reclaimTimer = setTimeout(() => {
    room.router.close(); // explicit close — mediasoup has NO garbage collection
    registry.delete(room.mediaRoomId);
  }, config.reconnectGraceMs);
}

/**
 * Force-remove a room: cancel any pending reclaim, close the Router, drop the
 * entry. Used on hard teardown (and to keep tests isolated).
 */
export function deleteRoom(mediaRoomId: string): void {
  const room = registry.get(mediaRoomId);
  if (!room) {
    return;
  }
  if (room.reclaimTimer) {
    clearTimeout(room.reclaimTimer);
    room.reclaimTimer = undefined;
  }
  room.router.close();
  registry.delete(mediaRoomId);
}
