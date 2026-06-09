// The raw-`ws` signaling gateway (NOT Socket.IO — locked decision).
//
// Per connection it: assigns a correlation id, owns an AwaitQueue that SERIALIZES
// every async media op (so two in-flight transport/produce/consume requests on one
// socket can't interleave and race mediasoup), Zod-validates EVERY inbound message
// at the boundary (T-01-11), enforces join-first (T-01-13), dispatches to handlers.ts,
// and runs disconnect cleanup on close.
//
// TLS termination (RESEARCH Q1): the nginx SNI router (Plan 05) forwards
// `sfu.sideby.me` → this backend port (default 8443). The SFU itself listens plain
// (the router terminates TLS), so we attach the ws server to a bare http server.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { AwaitQueue } from 'awaitqueue';
import { config } from '../config.js';
import { parseInbound, type InboundMessage } from './protocol.js';
import {
  handleJoin,
  handleGetRouterRtpCapabilities,
  handleCreateWebRtcTransport,
  handleConnectTransport,
  handleProduce,
  handleConsume,
  handleResume,
  handlePauseProducer,
  handleResumeProducer,
  handleDisconnect,
  type Session,
} from './handlers.js';
import type { Notification } from './protocol.js';
import { verifyJoin } from './auth.js';
import { logInfo, logWarn, emitIceState } from '../telemetry/events.js';

// Backend WSS port. The nginx SNI router (Plan 05) terminates TLS and forwards here.
const WSS_PORT = Number(process.env.SFU_WSS_PORT ?? 8443);

// connectionId → socket, so broadcastToRoom can fan out to other peers' sockets.
interface Conn {
  socket: WebSocket;
  session: Session;
}
const connections = new Map<string, Conn>();

// Push a notification to every OTHER peer in `mediaRoomId` (sender excluded). The
// gateway owns the socket registry; handlers call this via session.broadcastToRoom.
function broadcastToRoom(mediaRoomId: string, senderParticipantId: string, note: Notification): void {
  const frame = JSON.stringify(note);
  for (const { socket, session } of connections.values()) {
    if (session.mediaRoomId !== mediaRoomId) continue;
    if (session.participantId === senderParticipantId) continue;
    if (socket.readyState === socket.OPEN) {
      socket.send(frame);
    }
  }
}

// Reply helper: frame a handler result, echoing the request's correlation id.
function reply(socket: WebSocket, type: string, id: string | undefined, payload: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: `${type}:response`, id, payload }));
  }
}

function sendError(socket: WebSocket, id: string | undefined, message: string): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: 'error', id, payload: { message } }));
  }
}

// Dispatch one already-validated message to its handler. join-first is enforced
// here: any media op before a successful join is rejected (T-01-13).
async function dispatch(session: Session, socket: WebSocket, message: InboundMessage): Promise<void> {
  const joined = Boolean(session.peer);

  if (message.type !== 'join' && !joined) {
    sendError(socket, message.id, 'must join before any media operation');
    return;
  }

  switch (message.type) {
    case 'join': {
      // Gate admission AT THE BOUNDARY (T-01-12) — the single Phase-2 swap seam.
      // Reject before any room/peer state is touched.
      const decision = verifyJoin(message);
      if (!decision.ok) {
        logWarn('join rejected at gateway', {
          domain: 'signaling',
          event: 'join_rejected',
          connectionId: session.connectionId,
        });
        sendError(socket, message.id, 'join rejected');
        socket.close(1008, 'unauthorized');
        return;
      }
      reply(socket, 'join', message.id, await handleJoin(session, message));
      return;
    }
    case 'getRouterRtpCapabilities':
      reply(socket, 'getRouterRtpCapabilities', message.id, handleGetRouterRtpCapabilities(session));
      return;
    case 'createWebRtcTransport':
      reply(socket, 'createWebRtcTransport', message.id, await handleCreateWebRtcTransport(session, message));
      return;
    case 'connectTransport':
      reply(socket, 'connectTransport', message.id, await handleConnectTransport(session, message));
      // A connected transport is the relay-vs-direct signal (best-effort label).
      emitIceState('direct', { connectionId: session.connectionId });
      return;
    case 'produce':
      reply(socket, 'produce', message.id, await handleProduce(session, message));
      return;
    case 'consume':
      reply(socket, 'consume', message.id, await handleConsume(session, message));
      return;
    case 'resume':
      reply(socket, 'resume', message.id, await handleResume(session, message));
      return;
    case 'pauseProducer':
      reply(socket, 'pauseProducer', message.id, await handlePauseProducer(session, message));
      return;
    case 'resumeProducer':
      reply(socket, 'resumeProducer', message.id, await handleResumeProducer(session, message));
      return;
  }
}

/**
 * Start the WS signaling server on the configured WSS backend port. Returns the
 * underlying `ws` server so index.ts can register it with the SIGTERM drain.
 *
 * Must be called AFTER createWorkers() — handlers create transports on the
 * per-worker WebRtcServer.
 */
export function initSignalingServer(): WebSocketServer {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', socket => {
    const connectionId = randomUUID();
    // One AwaitQueue per connection serializes async ops (prevents interleaved
    // transport/produce/consume races on a single socket).
    const queue = new AwaitQueue();

    const session: Session = {
      connectionId,
      broadcastToRoom,
    };
    connections.set(connectionId, { socket, session });

    logInfo('ws connection accepted', { domain: 'signaling', event: 'ws_connect', connectionId });

    socket.on('message', raw => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        logWarn('ws message: invalid JSON, closing', { domain: 'signaling', event: 'ws_bad_json', connectionId });
        socket.close(1003, 'invalid json');
        return;
      }

      // Zod-validate EVERY message at the boundary before dispatch (T-01-11).
      const message = parseInbound(parsed);
      if (!message) {
        logWarn('ws message: protocol violation, closing', {
          domain: 'signaling',
          event: 'ws_protocol_violation',
          connectionId,
        });
        socket.close(1003, 'protocol violation');
        return;
      }

      // Enqueue on the per-conn AwaitQueue so ops run strictly in order.
      void queue
        .push(() => dispatch(session, socket, message), message.type)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logWarn('ws handler error', { domain: 'signaling', event: 'ws_handler_error', connectionId, error: msg });
          sendError(socket, message.id, msg);
        });
    });

    socket.on('close', () => {
      // disconnect analog: tear down media + broadcast producer-closed/participant-left.
      try {
        handleDisconnect(session);
      } finally {
        queue.stop();
        connections.delete(connectionId);
        logInfo('ws connection closed', { domain: 'signaling', event: 'ws_close', connectionId });
      }
    });

    socket.on('error', err => {
      logWarn('ws socket error', {
        domain: 'signaling',
        event: 'ws_socket_error',
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  httpServer.listen(WSS_PORT, () => {
    logInfo('sfu signaling server listening', {
      domain: 'signaling',
      event: 'wss_listen',
      port: WSS_PORT,
      // Surfaced so a misconfig (using the rtc/health port) is obvious in logs.
      announcedIp: config.announcedIp,
    });
  });

  return wss;
}
