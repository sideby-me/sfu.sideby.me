// One WebRtcServer per worker on a DISTINCT shared port (SFU-01, SFU-03).
//
// The shared-port WebRtcServer is what keeps the firewall surface to N ports
// (one per worker) instead of an ephemeral range per transport (Pitfall 4 — the
// per-transport rtcMin/MaxPort range bloats the firewall and breaks Docker).
//
// Two invariants this file exists to enforce:
//   1. announcedAddress MUST be config.announcedIp (a STATIC public IP from env,
//      D-03) — never '0.0.0.0' / the container-private IP. Advertising 0.0.0.0 as
//      an ICE candidate is THE #1 mediasoup failure: ICE reports "connected" yet
//      zero RTP flows because the advertised candidate is unroutable (Pitfall 1).
//   2. Each worker gets its OWN port (config.rtcBasePort + workerIndex). N workers
//      sharing one server/port collide ("port already in use") — Pitfall 4.
//
// Use `listenInfos` (the modern API, not the deprecated wildcard-IP form). Both
// udp and tcp listen on the SAME port for that worker (udp primary, tcp fallback
// for UDP-blocked networks).
import type { Worker, WebRtcServer } from 'mediasoup/node/lib/types.js';
import { config } from '../config.js';

// Each worker owns exactly one WebRtcServer; the signaling handlers (Plan 03) need
// the handle to create transports via `router.createWebRtcTransport({ webRtcServer })`
// (the shared-port path). Keyed by Worker so getWebRtcServer(worker) resolves it.
const serversByWorker = new WeakMap<Worker, WebRtcServer>();

/**
 * Create exactly one WebRtcServer for `worker`, bound to a shared port derived
 * from `config.rtcBasePort + workerIndex` (distinct per worker). Both udp and tcp
 * listen on that one port, each advertising the static `config.announcedIp`.
 */
export async function createWebRtcServer(worker: Worker, workerIndex: number): Promise<WebRtcServer> {
  const port = config.rtcBasePort + workerIndex;

  const server = await worker.createWebRtcServer({
    listenInfos: [
      {
        protocol: 'udp',
        ip: '0.0.0.0', // bind wildcard inside the container/host…
        announcedAddress: config.announcedIp, // …but ADVERTISE the static public IP (D-03)
        port,
      },
      {
        protocol: 'tcp',
        ip: '0.0.0.0',
        announcedAddress: config.announcedIp,
        port,
      },
    ],
  });

  serversByWorker.set(worker, server);
  return server;
}

/**
 * The WebRtcServer owned by `worker` (created in createWebRtcServer). The Plan 03
 * signaling handlers pass this to `router.createWebRtcTransport({ webRtcServer })`
 * so every transport rides the worker's shared port. Throws if the worker has no
 * server yet (programmer error — createWorkers() not run).
 */
export function getWebRtcServer(worker: Worker): WebRtcServer {
  const server = serversByWorker.get(worker);
  if (!server) {
    throw new Error('getWebRtcServer() called for a worker with no WebRtcServer — run createWorkers() first');
  }
  return server;
}
