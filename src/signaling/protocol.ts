// The app-defined WS signaling protocol (NOT Socket.IO — locked decision).
//
// Every inbound WS message is a JSON envelope `{ type, id?, payload }` validated at
// the gateway boundary BEFORE any handler runs (V5 Input Validation / T-01-11). An
// unknown `type` or a missing field is rejected and the connection is closed. `id`
// is an optional client-supplied correlation token echoed back on the matching
// response so the client can pair request→response over a single socket.
//
// HARD INVARIANT (SFU-02): payloads carry only opaque IDs (mediaRoomId,
// participantId, producerId, …) — no sideby product identifier ever appears here.
import { z } from 'zod';

// ── Shared primitives ────────────────────────────────────────────────────────
const Id = z.string().min(1);
const MediaKind = z.enum(['audio', 'video']);
// mediasoup capability/parameter blobs are opaque to the signaling layer — the
// Router/Device validate their internals. We accept structured JSON and pass through.
const Json = z.unknown();

// ── Inbound message schemas (client → SFU) ──────────────────────────────────
// `join` MUST be the first message (enforced by the gateway). `secret` carries the
// Phase-1 dev shared-secret (the Phase-2 HS256 token swaps in here, D-10).
export const JoinSchema = z.object({
  type: z.literal('join'),
  id: Id.optional(),
  payload: z.object({
    mediaRoomId: Id,
    participantId: Id,
    secret: z.string().optional(),
  }),
});

export const GetRouterRtpCapabilitiesSchema = z.object({
  type: z.literal('getRouterRtpCapabilities'),
  id: Id.optional(),
  payload: z.object({}).optional(),
});

export const CreateWebRtcTransportSchema = z.object({
  type: z.literal('createWebRtcTransport'),
  id: Id.optional(),
  payload: z.object({
    // which transport to create: 'send' (client→SFU) or 'recv' (SFU→client)
    direction: z.enum(['send', 'recv']),
  }),
});

export const ConnectTransportSchema = z.object({
  type: z.literal('connectTransport'),
  id: Id.optional(),
  payload: z.object({
    transportId: Id,
    dtlsParameters: Json,
  }),
});

export const ProduceSchema = z.object({
  type: z.literal('produce'),
  id: Id.optional(),
  payload: z.object({
    transportId: Id,
    kind: MediaKind,
    rtpParameters: Json,
  }),
});

export const ConsumeSchema = z.object({
  type: z.literal('consume'),
  id: Id.optional(),
  payload: z.object({
    transportId: Id,
    producerId: Id,
    rtpCapabilities: Json,
  }),
});

export const ResumeSchema = z.object({
  type: z.literal('resume'),
  id: Id.optional(),
  payload: z.object({
    consumerId: Id,
  }),
});

export const PauseProducerSchema = z.object({
  type: z.literal('pauseProducer'),
  id: Id.optional(),
  payload: z.object({
    producerId: Id,
  }),
});

export const ResumeProducerSchema = z.object({
  type: z.literal('resumeProducer'),
  id: Id.optional(),
  payload: z.object({
    producerId: Id,
  }),
});

// Discriminated union over `type` — the single parse point at the gateway. An
// unknown type fails the union (rejected + connection closed).
export const InboundMessageSchema = z.discriminatedUnion('type', [
  JoinSchema,
  GetRouterRtpCapabilitiesSchema,
  CreateWebRtcTransportSchema,
  ConnectTransportSchema,
  ProduceSchema,
  ConsumeSchema,
  ResumeSchema,
  PauseProducerSchema,
  ResumeProducerSchema,
]);

export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export type JoinMessage = z.infer<typeof JoinSchema>;

/**
 * Parse an unknown inbound value into a typed message, or return null if it does not
 * match the protocol (missing `type`, unknown `type`, or malformed payload). The
 * gateway closes the connection on null (T-01-11).
 */
export function parseInbound(raw: unknown): InboundMessage | null {
  const result = InboundMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ── Outbound notification type tags (SFU → client) ──────────────────────────
// These are server-pushed broadcasts/replies. Typed as string literals so handler
// call-sites are checked; the wire payloads are constructed in handlers.ts.
export type OutboundType =
  | 'joined'
  | 'new-producer'
  | 'producer-closed'
  | 'producer-paused'
  | 'producer-resumed'
  | 'participant-left';

/** A server→client notification envelope (mirrors the inbound `{ type, payload }`). */
export interface Notification {
  type: OutboundType;
  /** Optional correlation id echoed for request-shaped responses (e.g. `joined`). */
  id?: string;
  payload: Record<string, unknown>;
}
