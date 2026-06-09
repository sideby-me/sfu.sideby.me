// SFU bootstrap. Telemetry is initialized FIRST (before any service init) so that
// media incidents — the hardest class to debug post-hoc — are always observable
// (RESEARCH line 557, Pitfall 16). Later plans wire mediasoup/signaling/admin into
// the labeled mount-point below WITHOUT reordering telemetry or touching the drain.
import http from 'http';
import { config } from './config.js';
import { initializeTelemetry } from './telemetry/bootstrap.js';
import { logInfo, logWarn } from './telemetry/events.js';

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
// Plan 02: await createWorkers() (then registerWorkers(workers)) — immediately after
//          telemetry init, before the WS gateway.
// Plan 03: the WS signaling gateway.
// Plan 04: the admin server (extends the health surface below with /readiness + admin).

// ── Health placeholder (Plan 04 extends with /readiness + admin) ─────────────
const HEALTH_PORT = config.rtcBasePort - 1;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/_health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end("oh hello! it works btw, if that's what you are wondering");
    return;
  }

  if (req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status: 'ok', service: 'sfu' }));
    return;
  }

  res.statusCode = 404;
  res.end();
});

healthServer.listen(HEALTH_PORT, () => {
  logInfo('sfu health server listening', { domain: 'bootstrap', event: 'health_listen', port: HEALTH_PORT });
});

// ── Graceful drain ───────────────────────────────────────────────────────────
// Stop accepting new rooms, drain mediasoup workers (C++ subprocesses — no GC),
// then exit. tini (init: true in compose) reaps; this handler drains (Pitfall 5).
let draining = false;

async function drain(signal: NodeJS.Signals): Promise<void> {
  if (draining) return;
  draining = true;

  logInfo('received signal, draining...', { domain: 'bootstrap', event: 'signal_received', signal });

  try {
    healthServer.close();
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
