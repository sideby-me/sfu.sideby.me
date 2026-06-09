// SFU bootstrap. Telemetry is initialized FIRST (before any service init) so that
// media incidents — the hardest class to debug post-hoc — are always observable
// (RESEARCH line 557, Pitfall 16). Later plans wire mediasoup/signaling/admin into
// the labeled mount-point below WITHOUT reordering telemetry or touching the drain.
import { config } from './config.js';
import { initializeTelemetry } from './telemetry/bootstrap.js';
import { logInfo, logWarn } from './telemetry/events.js';
import { createWorkers, getWorkers } from './mediasoup/workers.js';
import { initSignalingServer } from './signaling/gateway.js';
import { mountAdmin } from './http/admin.js';

// ── Worker registry seam ────────────────────────────────────────────────────
// The SIGTERM drain closes whatever workers the mediasoup module owns. Plan 02's
// createWorkers() pushes the created workers here via registerWorkers(), so the
// drain handler below never needs editing when the worker pool lands.
interface ClosableWorker {
  close: () => void | Promise<void>;
}

let workers: ClosableWorker[] = [];

export function registerWorkers(created: ClosableWorker[]): void {
  workers = created;
}

// Telemetry-FIRST: this MUST be the first await in the process (RESEARCH line 557).
await initializeTelemetry({
  logger: {
    warn: (message, meta) => logWarn(message, { domain: 'other', event: 'telemetry_bootstrap', ...(meta ?? {}) }),
    info: (message, meta) => logInfo(message, { domain: 'other', event: 'telemetry_bootstrap', ...(meta ?? {}) }),
  },
});

logInfo('sfu config loaded', {
  domain: 'bootstrap',
  event: 'config_loaded',
  rtcBasePort: config.rtcBasePort,
  participantCap: config.participantCap,
  reconnectGraceMs: config.reconnectGraceMs,
});

// === media + signaling + admin servers mount here (Plans 02/03/04) ===
// Plan 02: the mediasoup worker pool — created here, immediately after telemetry
//          init and before the WS gateway. Each worker owns one shared-port
//          WebRtcServer with the static announcedAddress (D-03).
// Plan 03: the WS signaling gateway.
// Plan 04: the admin server (extends the health surface below with /readiness + admin).
await createWorkers();
// Hand the pool to the SIGTERM drain via the Plan-01 seam — the drain handler
// already closes whatever is registered, so no handler edit is needed.
registerWorkers(getWorkers());

// Plan 03: the WS signaling gateway. Started AFTER createWorkers() — its handlers
// create transports on the per-worker WebRtcServer, so the pool must exist first.
// The returned ws.Server is registered with the drain (close() matches the seam's
// ClosableWorker shape) so a SIGTERM stops accepting + closes open sockets.
const signalingServer = initSignalingServer();

// Plan 04: the S2S admin + health/readiness surface. Mounted AFTER createWorkers()
// because GET /readiness asserts the worker pool is up (getWorkers().length > 0).
// It replaces the Plan-01 inline /_health + /health placeholder and adds the
// X-Sfu-Secret-gated POST /rooms ensure-room entry on an INTERNAL port (never the
// public SNI router — Plan 05 firewalls it). The admin server is closed on SIGTERM
// via the same drain seam as the workers + signaling server.
const adminServer = mountAdmin();
registerWorkers([
  ...getWorkers(),
  { close: () => signalingServer.close() },
  { close: () => adminServer.close() },
]);

// ── Graceful drain ───────────────────────────────────────────────────────────
// Stop accepting new rooms, drain mediasoup workers (C++ subprocesses — no GC),
// then exit. tini (init: true in compose) reaps; this handler drains (Pitfall 5).
let draining = false;

async function drain(signal: NodeJS.Signals): Promise<void> {
  if (draining) return;
  draining = true;

  logInfo('received signal, draining...', { domain: 'bootstrap', event: 'signal_received', signal });

  try {
    // The admin/health server and the signaling server are both registered in
    // `workers` via the Plan-01 seam, so closing the registry drains them all.
    await Promise.all(workers.map(w => w.close()));
  } catch (err) {
    logWarn('drain encountered an error', {
      domain: 'bootstrap',
      event: 'drain_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  process.exit(0);
}

process.on('SIGTERM', () => void drain('SIGTERM'));
process.on('SIGINT', () => void drain('SIGINT'));
