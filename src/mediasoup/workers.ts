// mediasoup Worker pool (SFU-01) — one Worker per available CPU, each owning one
// WebRtcServer on a distinct shared port (webrtc-server.ts).
//
// Three things this module gets right that mediasoup deployments routinely get wrong:
//   1. Pool size = the CGROUP CPU limit, NOT os.cpus().length. Inside a container
//      os.cpus() reports the HOST core count, so a 2-vCPU droplet would spawn (say)
//      16 workers and thrash. We read the cgroup quota (Pattern 1, Pitfall 4).
//   2. A worker 'died' event is unrecoverable for that subprocess — we emit the
//      worker_died OTEL counter then process.exit(1) so the orchestrator restarts
//      the whole container (RESEARCH §createWorker).
//   3. The created workers are handed to the SIGTERM drain via registerWorkers()
//      (the Plan-01 index.ts seam) so shutdown closes every C++ subprocess cleanly.
import os from 'node:os';
import fs from 'node:fs';
import * as mediasoup from 'mediasoup';
import type { Worker } from 'mediasoup/node/lib/types.js';
import { emitWorkerDied, logError, logInfo } from '../telemetry/events.js';
import { createWebRtcServer } from './webrtc-server.js';

interface PooledWorker {
  worker: Worker;
  index: number;
}

const pool: PooledWorker[] = [];
let nextWorkerIndex = 0;

/**
 * Effective CPU count for sizing the worker pool. Reads the cgroup CPU quota
 * (cgroup v2 `cpu.max`, then cgroup v1 `cpu.cfs_quota_us`/`cpu.cfs_period_us`),
 * falling back to os.cpus().length only when no cgroup limit is discoverable.
 * Inside a container os.cpus() reports HOST cores, so the cgroup is the source of
 * truth for "how many cores can this container actually use" (Pattern 1).
 */
export function getCpuLimit(): number {
  // cgroup v2: /sys/fs/cgroup/cpu.max → "<quota> <period>" or "max <period>".
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const [quotaStr, periodStr] = raw.split(/\s+/);
    if (quotaStr && quotaStr !== 'max') {
      const quota = Number(quotaStr);
      const period = Number(periodStr ?? 100000);
      if (quota > 0 && period > 0) {
        return Math.max(1, Math.floor(quota / period));
      }
    }
  } catch {
    // cgroup v2 file absent — fall through to v1.
  }

  // cgroup v1: cfs_quota_us / cfs_period_us.
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.floor(quota / period));
    }
  } catch {
    // cgroup v1 files absent — fall through to host core count.
  }

  // No cgroup limit (bare metal / dev): host cores is correct here.
  return Math.max(1, os.cpus().length);
}

/**
 * Create the worker pool sized to the cgroup CPU limit. Each worker logs at 'warn',
 * gets a 'died' handler (emit OTEL + exit so the orchestrator restarts), and owns
 * exactly one WebRtcServer on its own shared port (rtcBasePort + index).
 *
 * Idempotent: a second call returns the already-created pool without spawning more.
 */
export async function createWorkers(): Promise<Worker[]> {
  if (pool.length > 0) {
    return pool.map(p => p.worker);
  }

  const numWorkers = getCpuLimit();
  logInfo('creating mediasoup worker pool', {
    domain: 'mediasoup',
    event: 'worker_pool_create',
    numWorkers,
  });

  for (let index = 0; index < numWorkers; index++) {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });

    worker.on('died', error => {
      // A dead worker is unrecoverable for its subprocess; emit telemetry then
      // exit so the orchestrator restarts the container (RESEARCH §createWorker).
      emitWorkerDied({ workerIndex: String(index) });
      logError('mediasoup worker died — exiting for orchestrator restart', {
        domain: 'mediasoup',
        event: 'worker_died',
        workerIndex: index,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });

    // One WebRtcServer per worker on a distinct shared port (announcedAddress set).
    await createWebRtcServer(worker, index);

    pool.push({ worker, index });
  }

  logInfo('mediasoup worker pool ready', {
    domain: 'mediasoup',
    event: 'worker_pool_ready',
    numWorkers: pool.length,
  });

  return pool.map(p => p.worker);
}

/**
 * Round-robin the next worker for pinning a Router at room-creation time. A Router
 * (= one conference) lives entirely on one worker; round-robin spreads rooms across
 * the pool. Throws if the pool has not been created yet (programmer error).
 */
export function getNextWorker(): Worker {
  if (pool.length === 0) {
    throw new Error('getNextWorker() called before createWorkers()');
  }
  const { worker } = pool[nextWorkerIndex % pool.length]!;
  nextWorkerIndex++;
  return worker;
}

/** The created workers — exposed so the SIGTERM drain can close them all. */
export function getWorkers(): Worker[] {
  return pool.map(p => p.worker);
}

/** Close every worker subprocess (called by the SIGTERM drain via index.ts). */
export async function closeWorkers(): Promise<void> {
  await Promise.all(pool.map(p => p.worker.close()));
  pool.length = 0;
  nextWorkerIndex = 0;
}
