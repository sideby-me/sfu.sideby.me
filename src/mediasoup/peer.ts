// Peer — one opaque participant's media state within a MediaRoom.
//
// HARD INVARIANT (SFU-02 / Pitfall 11): a Peer is keyed by an opaque participantId
// and holds NO sideby identifier — no product-level user, name, room kind, or OTT
// concept. The SFU never learns who the participant is.
//
// This file defines the DATA STRUCTURE + teardown CONTRACT that the Plan 03
// signaling handlers depend on: they create the send/recv transports, populate the
// producer/consumer maps as the client produces/consumes, and call peer.close() on
// WS close. Producers are closed explicitly (and first) so Plan 03 can fire the
// per-producer "producer-closed" broadcast before the transport cascade — closing a
// transport would otherwise close its producers/consumers silently (RESEARCH §cleanup).
import type {
  WebRtcTransport,
  Producer,
  Consumer,
} from 'mediasoup/types';

export class Peer {
  /** Opaque participant key — the ONLY identifier the SFU holds for this peer. */
  readonly participantId: string;

  /** Send transport (client → SFU); created on demand by the signaling handlers. */
  sendTransport?: WebRtcTransport;

  /** Recv transport (SFU → client); created on demand by the signaling handlers. */
  recvTransport?: WebRtcTransport;

  /** producerId → Producer for everything this peer is sending. */
  readonly producers: Map<string, Producer> = new Map();

  /** consumerId → Consumer for everything this peer is receiving. */
  readonly consumers: Map<string, Consumer> = new Map();

  private closed = false;

  constructor(participantId: string) {
    this.participantId = participantId;
  }

  /**
   * Tear down all media for this peer (RESEARCH §cleanup). Order matters:
   *   1. consumers — stop receiving first.
   *   2. producers — closed explicitly (Plan 03 broadcasts per-producer here).
   *   3. send + recv transports — closing a transport cascades to anything left.
   * Idempotent: a second call is a no-op (guarded), so a WS-close race plus an
   * explicit teardown can't double-close mediasoup objects.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = undefined;
    this.recvTransport = undefined;
  }

  /** Whether close() has already run — lets handlers skip redundant teardown. */
  isClosed(): boolean {
    return this.closed;
  }
}
