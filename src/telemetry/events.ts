// SFU domain-event emitters (SFU-12). Mirrors the instrument-cache + fail-open
// pattern of sync.sideby.me/src/server/telemetry/metrics.ts and re-exports the
// structured-log helpers from ./logs.ts. Every emit is wrapped try/catch so a
// broken exporter never stalls the media plane (Pitfall 16 / Fail-open telemetry).
//
// These emitters are called by later plans (workers, signaling, ice-servers) —
// the signatures here are STABLE and should not change.
import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

// Re-export the structured logger so callers have one telemetry entry point.
export { logInfo, logWarn, logError } from './logs.js';

/** ICE selected-pair transport class — the relay-vs-direct signal (Pitfall 16). */
export type IceTransportKind = 'relay' | 'direct';

interface SfuInstruments {
  transportConnected: Counter;
  iceState: Counter;
  producerCreated: Counter;
  bytesReceivedZero: Counter;
  workerDied: Counter;
  turnCredentialIssued: Counter;
  /** Relay-vs-direct ratio gauge surrogate: observed ICE transport class, 0=direct / 1=relay. */
  relayRatio: Histogram;
}

let instruments: SfuInstruments | null = null;

// Creates and caches the SFU domain-event instruments.
function getInstruments(): SfuInstruments {
  if (instruments) {
    return instruments;
  }

  const meter = metrics.getMeter('sfu.sideby.me', '1.0.0');

  instruments = {
    transportConnected: meter.createCounter('sfu_transport_connected_total', {
      description: 'WebRTC transports that reached the connected DTLS state',
      unit: '{transport}',
    }),
    iceState: meter.createCounter('sfu_ice_state_total', {
      description: 'ICE connection-state transitions, labelled relay|direct',
      unit: '{transition}',
    }),
    producerCreated: meter.createCounter('sfu_producer_created_total', {
      description: 'Producers created on the SFU',
      unit: '{producer}',
    }),
    bytesReceivedZero: meter.createCounter('sfu_bytes_received_zero_total', {
      description: 'Transports observed with bytesReceived==0 (no RTP flowing — alert)',
      unit: '{transport}',
    }),
    workerDied: meter.createCounter('sfu_worker_died_total', {
      description: 'mediasoup worker subprocess deaths',
      unit: '{worker}',
    }),
    turnCredentialIssued: meter.createCounter('sfu_turn_credential_issued_total', {
      description: 'coturn HMAC credentials minted and handed to clients',
      unit: '{credential}',
    }),
    relayRatio: meter.createHistogram('sfu_ice_relay_ratio', {
      description: 'ICE transport class per connection (0=direct, 1=relay) — early warning for announcedAddress/TURN regressions',
      unit: '1',
    }),
  };

  return instruments;
}

// transport_connected — a WebRTC transport reached the connected state.
export function emitTransportConnected(attributes?: Record<string, string>): void {
  try {
    getInstruments().transportConnected.add(1, attributes);
  } catch {
    // Fail-open: telemetry must never affect media-plane behavior.
  }
}

// ice_state{relay|direct} — an ICE selected-pair transition was observed.
export function emitIceState(kind: IceTransportKind, attributes?: Record<string, string>): void {
  try {
    const insts = getInstruments();
    insts.iceState.add(1, { ...attributes, transport: kind });
    // Feed the relay-vs-direct ratio: relay=1, direct=0.
    insts.relayRatio.record(kind === 'relay' ? 1 : 0, { ...attributes, transport: kind });
  } catch {
    // Fail-open.
  }
}

// producer_created — a producer was created on the SFU.
export function emitProducerCreated(attributes?: Record<string, string>): void {
  try {
    getInstruments().producerCreated.add(1, attributes);
  } catch {
    // Fail-open.
  }
}

// bytes_received==0 — a transport showed no inbound RTP (the alert counter).
export function emitBytesReceivedZero(attributes?: Record<string, string>): void {
  try {
    getInstruments().bytesReceivedZero.add(1, attributes);
  } catch {
    // Fail-open.
  }
}

// worker_died — a mediasoup worker subprocess died.
export function emitWorkerDied(attributes?: Record<string, string>): void {
  try {
    getInstruments().workerDied.add(1, attributes);
  } catch {
    // Fail-open.
  }
}

// turn_credential_issued — a coturn HMAC credential was minted for a client.
export function emitTurnCredentialIssued(attributes?: Record<string, string>): void {
  try {
    getInstruments().turnCredentialIssued.add(1, attributes);
  } catch {
    // Fail-open.
  }
}
