// The SFU server-to-server admin + health/readiness surface (SFU-10).
//
// Two consumers, two trust boundaries:
//   • S2S caller → POST /rooms  — server-to-server room provisioning. Gated by the
//     `X-Sfu-Secret` header (mirrors lens's `X-Lens-Secret`). If exposed publicly it
//     would be an SSRF/abuse surface, so it must live on an INTERNAL port the public
//     SNI router never reaches (Plan 05 firewalls it; RESEARCH line 727).
//   • LB / ops → GET /readiness — the deploy/health gate. Returns 200 only when the
//     mediasoup worker pool is up, 503 otherwise.
//
// HARD INVARIANT (SFU-02 / Pitfall 11): the admin surface carries OPAQUE IDs only.
// The create-room schema deliberately has NO product fields (no user, name, room
// kind, OTT) — the SFU never learns what product a mediaRoomId maps to (T-01-17).
//
// Shape mirrors the existing raw-`http` health server (index.ts) — the SFU declares
// no Express dependency, so we stay on Node's built-in http like the rest of the
// service. `.js` import extensions (Node16 resolution).
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { config } from '../config.js';
import { ensureRoom } from '../room-registry.js';
import { getWorkers } from '../mediasoup/workers.js';
import { logInfo, logWarn, logError } from '../telemetry/events.js';

// Create-room request body. OPAQUE FIELDS ONLY (T-01-17): an opaque mediaRoomId and
// an optional per-room participant-cap override (SFU-11). NO product identifiers.
const CreateRoomSchema = z.object({
  mediaRoomId: z.string().min(1, 'mediaRoomId is required'),
  participantCap: z.number().int().positive().optional(),
});

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage, maxBytes = 10_240): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

// The X-Sfu-Secret gate (T-01-15). Mirrors lens's authMiddleware: when no admin
// secret is configured we allow (dev-open); otherwise the header MUST match exactly.
// This is the single S2S auth touch-point for the admin surface.
function isAuthorized(req: IncomingMessage): boolean {
  if (!config.adminSecret) {
    return true; // dev-open: no secret configured
  }
  return req.headers['x-sfu-secret'] === config.adminSecret;
}

// Readiness asserts the mediasoup worker pool is UP (≥1 worker). This is what the
// load balancer / deploy gate polls — a pool of zero means the SFU cannot create
// transports, so it must NOT receive traffic (503).
function isReady(): boolean {
  return getWorkers().length > 0;
}

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Secret gate FIRST — reject before reading the body (T-01-15).
  if (!isAuthorized(req)) {
    logWarn('admin create-room: unauthorized', { domain: 'bootstrap', event: 'admin_unauthorized' });
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const body = await readJsonBody(req);

    // Zod-validate-then-act (T-01-16): malformed body → 400 with the first issue.
    const parsed = CreateRoomSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid request' });
      return;
    }

    // ensureRoom is idempotent and carries ONLY the opaque mediaRoomId.
    const room = await ensureRoom(parsed.data.mediaRoomId);

    logInfo('admin create-room', {
      domain: 'bootstrap',
      event: 'admin_room_ensured',
      mediaRoomId: room.mediaRoomId,
    });

    // 201 with the OPAQUE room descriptor — no product data leaves the SFU.
    sendJson(res, 201, {
      mediaRoomId: room.mediaRoomId,
      participantCap: parsed.data.participantCap ?? config.participantCap,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    if (message === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: 'Request body too large' });
      return;
    }
    if (message === 'INVALID_JSON') {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    logError('admin create-room: unexpected error', {
      domain: 'bootstrap',
      event: 'admin_room_error',
      error: message,
    });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

/**
 * The admin/health/readiness request handler. Exported separately from mountAdmin so
 * it can be unit-tested without binding a port. Routes:
 *   POST /rooms      → X-Sfu-Secret-gated, Zod-validated ensure-room (201)
 *   GET  /readiness  → 200 when the worker pool is up, 503 otherwise
 *   GET  /health     → 200 JSON { status: 'ok', service: 'sfu' }
 *   GET  /_health    → 200 plaintext (lens shape, no-store)
 */
export function createAdminHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function adminHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];

    if (req.method === 'POST' && path === '/rooms') {
      await handleCreateRoom(req, res);
      return;
    }

    if (req.method === 'GET' && path === '/readiness') {
      if (isReady()) {
        sendJson(res, 200, { status: 'ready', service: 'sfu' });
      } else {
        sendJson(res, 503, { status: 'not-ready', service: 'sfu' });
      }
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'sfu' });
      return;
    }

    if (req.method === 'GET' && path === '/_health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end("oh hello! it works btw, if that's what you are wondering");
      return;
    }

    res.statusCode = 404;
    res.end();
  };
}

/**
 * Mount the admin surface on its own internal http server and start listening.
 * Returns the server so index.ts can register it with the SIGTERM drain.
 *
 * The admin/health port is INTERNAL — ops/LB reach it directly, never via the public
 * SNI router (Plan 05 firewalls it). Defaults to `rtcBasePort - 1` to match the
 * Plan-01 health placeholder this replaces.
 */
export function mountAdmin(): http.Server {
  const port = Number(process.env.SFU_ADMIN_PORT ?? config.rtcBasePort - 1);
  const handler = createAdminHandler();

  const server = http.createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      logError('admin handler crashed', {
        domain: 'bootstrap',
        event: 'admin_handler_crash',
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  server.listen(port, () => {
    logInfo('sfu admin server listening', { domain: 'bootstrap', event: 'admin_listen', port });
  });

  return server;
}
