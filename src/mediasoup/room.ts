// MediaRoom — the in-memory model behind one opaque mediaRoomId.
//
// HARD INVARIANT (SFU-02 / Pitfall 11): a MediaRoom holds ONLY opaque identifiers.
// There is deliberately no product-level room key, user, name, room kind, or OTT
// field — the SFU knows nothing about sideby products. A conference is exactly one
// Router plus a Map of opaque participantId → Peer.
import type { Router, Worker } from 'mediasoup/types';
import type { Peer } from './peer.js';

export interface MediaRoom {
  /** Opaque room key. The SFU never learns what product/room this maps to. */
  mediaRoomId: string;
  /** The single Router for this conference, pinned to one worker at creation. */
  router: Router;
  /** The worker the router is pinned to — resolves the shared-port WebRtcServer. */
  worker: Worker;
  /** Opaque participantId → Peer. Map size is the source of truth for the cap. */
  peers: Map<string, Peer>;
  /** Pending reclaim timer when the room is empty; cleared on rejoin. */
  reclaimTimer?: ReturnType<typeof setTimeout>;
}
