// The SINGLE join-authentication touch-point (D-10) — the Phase-2 swap seam.
//
// Phase 1 (now): a dev shared-secret gate, exactly mirroring lens.sideby.me's
// `authMiddleware` env-gate (lines 88-100): if no secret is configured the SFU is
// dev-open; otherwise the join message's `secret` must equal SFU_DEV_SECRET.
//
// Phase 2 (TOKEN-*): this ONE function body is replaced with offline HS256 token
// verification (the token pins mediaRoomId + participantId). NOTHING else changes —
// the gateway and the entire media plane call `verifyJoin` and never learn how the
// decision is made. Keeping auth to a single function is what makes that swap clean.
//
// THREAT NOTE (T-01-12): the Phase-1 dev secret is COARSE — it admits, it does not
// scope to a room/participant. That is acceptable ONLY because the SFU holds no
// product data (opaque IDs only). Phase 2's token closes the cross-room gap.
import { config } from '../config.js';
import type { JoinMessage } from './protocol.js';

export interface JoinDecision {
  ok: boolean;
  /** Populated on rejection — surfaced in the structured close log, never to the wire. */
  reason?: string;
}

/**
 * Gate a (Zod-validated) `join` message.
 *   - SFU_DEV_SECRET unset  → allow (dev-open).
 *   - SFU_DEV_SECRET set    → allow iff payload.secret === SFU_DEV_SECRET.
 *
 * This is the ONLY auth decision in the signaling plane. Do not add auth checks
 * elsewhere — Phase 2 replaces this body alone.
 */
export function verifyJoin(message: JoinMessage): JoinDecision {
  // Dev-open: no secret configured means any join is admitted (local/dev).
  if (!config.devSecret) {
    return { ok: true };
  }

  if (message.payload.secret !== config.devSecret) {
    return { ok: false, reason: 'invalid_dev_secret' };
  }

  return { ok: true };
}
