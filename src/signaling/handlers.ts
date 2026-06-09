// Signaling handlers — the full mediasoup server-side handshake driven by the WS
// gateway (one handler per protocol message; each Zod-validated upstream).
//
// Flow (RESEARCH Pattern 2/3):
//   join → getRouterRtpCapabilities → createWebRtcTransport(send,recv)
//        → connectTransport (DTLS) → produce → consume(paused) → resume
//   + wire-level mute (pause/resumeProducer) + disconnect cleanup broadcasts.
//
// The gateway owns the socket; handlers own the media objects. Handlers receive a
// per-connection `Session` (the bound socket + peer/room refs) and return the reply
// payload (the gateway frames + sends it, echoing the request `id`). Broadcasts go
// out-of-band via the session's `broadcastToRoom`.
//
// HARD INVARIANT (SFU-02): only opaque IDs cross this layer.
import type {
  WebRtcTransport,
  DtlsParameters,
  RtpParameters,
  RtpCapabilities,
} from 'mediasoup/node/lib/types.js';
import type { MediaKind } from 'mediasoup/node/lib/rtpParametersTypes.js';
import { ensureRoom, assertCanAdmit, getRoom, handlePeerLeave } from '../room-registry.js';
import { getWebRtcServer } from '../mediasoup/webrtc-server.js';
import { Peer } from '../mediasoup/peer.js';
import type { MediaRoom } from '../mediasoup/room.js';
import { buildIceServers } from '../turn/ice-servers.js';
import { verifyJoin } from './auth.js';
import type {
  JoinMessage,
  ConnectTransportSchema,
  CreateWebRtcTransportSchema,
  ProduceSchema,
  ConsumeSchema,
  ResumeSchema,
  PauseProducerSchema,
  ResumeProducerSchema,
  Notification,
} from './protocol.js';
import type { z } from 'zod';
import { emitTransportConnected, emitProducerCreated, logInfo, logWarn } from '../telemetry/events.js';

// A live signaling connection's state. The gateway constructs one per socket and
// passes it to each handler. `broadcastToRoom` excludes the sender's own socket.
export interface Session {
  /** Per-connection correlation id (gateway-assigned). */
  connectionId: string;
  /** Set on a successful join. */
  mediaRoomId?: string;
  participantId?: string;
  peer?: Peer;
  /** Push a notification to every OTHER peer's socket in `mediaRoomId`. */
  broadcastToRoom: (mediaRoomId: string, participantId: string, note: Notification) => void;
}

const SEND = 'send' as const;

function requireJoined(session: Session): { room: MediaRoom; peer: Peer; participantId: string } {
  if (!session.mediaRoomId || !session.participantId || !session.peer) {
    throw new Error('media op before join');
  }
  const room = getRoom(session.mediaRoomId);
  if (!room) {
    throw new Error('room no longer exists');
  }
  return { room, peer: session.peer, participantId: session.participantId };
}

// ── join ──────────────────────────────────────────────────────────────────────
// verifyJoin → ensureRoom + cap guard → create Peer → reply with the Router's
// rtpCapabilities, the freshly-minted coturn iceServers (TURN-03), and the list of
// existing producers so the joiner auto-consumes them.
export async function handleJoin(session: Session, message: JoinMessage): Promise<Record<string, unknown>> {
  // Defence in depth: the gateway gates join via verifyJoin at the boundary, but the
  // handler re-checks so handleJoin is never reachable with an un-vetted message.
  const decision = verifyJoin(message);
  if (!decision.ok) {
    throw new Error(`join rejected: ${decision.reason ?? 'unauthorized'}`);
  }

  const { mediaRoomId, participantId } = message.payload;
  const room = await ensureRoom(mediaRoomId);
  assertCanAdmit(room); // SFU-11 — over-cap join rejected at the boundary

  const peer = new Peer(participantId);
  room.peers.set(participantId, peer);

  session.mediaRoomId = mediaRoomId;
  session.participantId = participantId;
  session.peer = peer;

  // Existing producers across all OTHER peers — the joiner consumes these to render
  // the people already in the room (the existing-peers handshake).
  const existingProducers: Array<{ producerId: string; participantId: string; kind: MediaKind }> = [];
  for (const [otherId, otherPeer] of room.peers) {
    if (otherId === participantId) continue;
    for (const producer of otherPeer.producers.values()) {
      existingProducers.push({ producerId: producer.id, participantId: otherId, kind: producer.kind });
    }
  }

  logInfo('peer joined media room', {
    domain: 'signaling',
    event: 'peer_joined',
    connectionId: session.connectionId,
  });

  return {
    rtpCapabilities: room.router.rtpCapabilities,
    // coturn creds live ONLY here — never a separate endpoint, never static (TURN-03).
    iceServers: buildIceServers(participantId),
    existingProducers,
  };
}

// ── getRouterRtpCapabilities ───────────────────────────────────────────────────
export function handleGetRouterRtpCapabilities(session: Session): Record<string, unknown> {
  const { room } = requireJoined(session);
  return { rtpCapabilities: room.router.rtpCapabilities };
}

// ── createWebRtcTransport (send + recv) ─────────────────────────────────────────
// Shared-port path: pass the worker's WebRtcServer, do NOT also pass listenInfos.
export async function handleCreateWebRtcTransport(
  session: Session,
  message: z.infer<typeof CreateWebRtcTransportSchema>,
): Promise<Record<string, unknown>> {
  const { room, peer } = requireJoined(session);
  const webRtcServer = getWebRtcServer(room.worker);

  const transport: WebRtcTransport = await room.router.createWebRtcTransport({
    webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  if (message.payload.direction === SEND) {
    peer.sendTransport = transport;
  } else {
    peer.recvTransport = transport;
  }

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

function resolveTransport(peer: Peer, transportId: string): WebRtcTransport {
  if (peer.sendTransport?.id === transportId) return peer.sendTransport;
  if (peer.recvTransport?.id === transportId) return peer.recvTransport;
  throw new Error('unknown transport');
}

// ── connectTransport (DTLS handshake, SFU-03) ───────────────────────────────────
export async function handleConnectTransport(
  session: Session,
  message: z.infer<typeof ConnectTransportSchema>,
): Promise<Record<string, unknown>> {
  const { peer } = requireJoined(session);
  const transport = resolveTransport(peer, message.payload.transportId);
  await transport.connect({ dtlsParameters: message.payload.dtlsParameters as DtlsParameters });
  emitTransportConnected({ connectionId: session.connectionId });
  return { connected: true };
}

// ── produce (SFU-04) ─────────────────────────────────────────────────────────
// Create the producer on the send transport, then broadcast new-producer so other
// peers in the room consume it.
export async function handleProduce(
  session: Session,
  message: z.infer<typeof ProduceSchema>,
): Promise<Record<string, unknown>> {
  const { peer, participantId, room } = requireJoined(session);
  const transport = resolveTransport(peer, message.payload.transportId);

  const producer = await transport.produce({
    kind: message.payload.kind as MediaKind,
    rtpParameters: message.payload.rtpParameters as RtpParameters,
  });
  peer.producers.set(producer.id, producer);
  emitProducerCreated({ connectionId: session.connectionId });

  session.broadcastToRoom(room.mediaRoomId, participantId, {
    type: 'new-producer',
    payload: { producerId: producer.id, participantId, kind: message.payload.kind },
  });

  return { id: producer.id };
}

// ── consume (SFU-05) — ALWAYS paused ────────────────────────────────────────────
// Losing the first keyframe freezes video, so the consumer is created paused and the
// client resumes it only after attaching its local consumer (Pattern 3).
export async function handleConsume(
  session: Session,
  message: z.infer<typeof ConsumeSchema>,
): Promise<Record<string, unknown>> {
  const { peer, room } = requireJoined(session);
  const { producerId, rtpCapabilities, transportId } = message.payload;

  if (!room.router.canConsume({ producerId, rtpCapabilities: rtpCapabilities as RtpCapabilities })) {
    throw new Error('cannot consume — incompatible rtpCapabilities');
  }

  const transport = resolveTransport(peer, transportId);
  const consumer = await transport.consume({
    producerId,
    rtpCapabilities: rtpCapabilities as RtpCapabilities,
    paused: true, // ALWAYS paused — resumed after the client attaches (SFU-05)
  });
  peer.consumers.set(consumer.id, consumer);

  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
}

// ── resume (SFU-05) — resume a paused consumer once the client has attached ──────
export async function handleResume(
  session: Session,
  message: z.infer<typeof ResumeSchema>,
): Promise<Record<string, unknown>> {
  const { peer } = requireJoined(session);
  const consumer = peer.consumers.get(message.payload.consumerId);
  if (!consumer) {
    throw new Error('unknown consumer');
  }
  await consumer.resume();
  return { resumed: true };
}

// ── pauseProducer / resumeProducer (wire-level mute, SFU-06) ─────────────────────
export async function handlePauseProducer(
  session: Session,
  message: z.infer<typeof PauseProducerSchema>,
): Promise<Record<string, unknown>> {
  const { peer, participantId, room } = requireJoined(session);
  const producer = peer.producers.get(message.payload.producerId);
  if (!producer) {
    throw new Error('unknown producer');
  }
  await producer.pause();
  session.broadcastToRoom(room.mediaRoomId, participantId, {
    type: 'producer-paused',
    payload: { producerId: producer.id, participantId },
  });
  return { paused: true };
}

export async function handleResumeProducer(
  session: Session,
  message: z.infer<typeof ResumeProducerSchema>,
): Promise<Record<string, unknown>> {
  const { peer, participantId, room } = requireJoined(session);
  const producer = peer.producers.get(message.payload.producerId);
  if (!producer) {
    throw new Error('unknown producer');
  }
  await producer.resume();
  session.broadcastToRoom(room.mediaRoomId, participantId, {
    type: 'producer-resumed',
    payload: { producerId: producer.id, participantId },
  });
  return { resumed: true };
}

// ── disconnect cleanup (SFU-08) — invoked by the gateway on WS close ─────────────
// Broadcast producer-closed PER producer BEFORE the transport cascade closes them
// silently, then participant-left, then arm the registry reclaim if the room emptied.
export function handleDisconnect(session: Session): void {
  if (!session.mediaRoomId || !session.participantId || !session.peer) {
    return; // never completed a join — nothing to tear down
  }
  const room = getRoom(session.mediaRoomId);
  const { participantId, peer } = { participantId: session.participantId, peer: session.peer };

  if (room) {
    // Per-producer broadcast first — peer.close() (consumers→producers→transports)
    // would otherwise close producers silently.
    for (const producer of peer.producers.values()) {
      session.broadcastToRoom(room.mediaRoomId, participantId, {
        type: 'producer-closed',
        payload: { producerId: producer.id, participantId },
      });
    }
  }

  peer.close();

  if (room) {
    room.peers.delete(participantId);
    session.broadcastToRoom(room.mediaRoomId, participantId, {
      type: 'participant-left',
      payload: { participantId },
    });
    // Arm grace-timer reclaim if the room is now empty (SFU-09) — registry-owned.
    handlePeerLeave(room);
  }

  logWarn('peer disconnected, cleaned up', {
    domain: 'signaling',
    event: 'peer_disconnected',
    connectionId: session.connectionId,
  });

  session.mediaRoomId = undefined;
  session.participantId = undefined;
  session.peer = undefined;
}
