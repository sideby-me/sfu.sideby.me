// dev/client.ts — THROWAWAY D-09 validation harness (raw `mediasoup-client`).
//
// This is NOT @sideby/media-sdk (that is Phase 3). It is a deliberately minimal,
// dependency-light smoke-test page whose ONLY job is to drive the Phase-1 phase-done
// gates against the deployed SFU:
//
//   GATE 1 (success criterion #1): two clients on DIFFERENT public networks show
//           `bytesReceived > 0` on the recv transport — the announcedAddress /
//           host-networking media gate (ICE "connected" but zero bytes is the #1
//           mediasoup failure mode; this page catches it).
//   GATE 2 (success criterion #2): the force-relay toggle (`iceTransportPolicy:
//           'relay'`) forces every candidate through coturn; media still flows over
//           `turns:`/443 from a UDP-blocked network.
//
// Flow (RESEARCH Pattern 2/3 — verbatim handshake the Plan-03 gateway speaks):
//   connect WSS → join (dev-secret) → getRouterRtpCapabilities → device.load
//     → createSendTransport({ ..., iceServers })   ← iceServers from the `joined` reply
//     → createRecvTransport({ ..., iceServers })
//     → getUserMedia({ audio, video }) → produce(mic) → produce(cam)
//     → on `new-producer` → consume → resume → attach to <video>/<audio>
//
// HARD INVARIANT (SFU-02): the page uses ONLY opaque IDs — a `mediaRoomId` and a
// `participantId`. It never references a sideby product identifier.
//
// Loaded as a browser ES module via esbuild/vite (see dev/README.md). The Plan-05
// tsconfig only includes `src/**`, so this file is already excluded from the
// production `tsc` build / image — it is a throwaway dev artifact.
import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer } from 'mediasoup-client/lib/types';

// ── Tiny correlated request/response WS client ─────────────────────────────────
// The Plan-03 gateway frames replies as `{ type: "<msg>:response", id, payload }`
// and pushes broadcasts as `{ type, payload }`. We correlate request→response by a
// client-supplied `id` and route un-correlated broadcasts to a handler.
type Notification = { type: string; payload: Record<string, unknown> };

class SignalClient {
  private ws!: WebSocket;
  private nextId = 0;
  private pending = new Map<string, { resolve: (p: any) => void; reject: (e: Error) => void }>();
  onNotification: (note: Notification) => void = () => {};

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WS connection failed: ${url}`));
      this.ws.onclose = () => log('WS closed');
      this.ws.onmessage = ev => this.onMessage(String(ev.data));
    });
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { type: string; id?: string; payload: any };
    // Correlated response or error for an in-flight request.
    if (msg.id && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.type === 'error') waiter.reject(new Error(String(msg.payload?.message ?? 'error')));
      else waiter.resolve(msg.payload);
      return;
    }
    // Server-pushed broadcast (new-producer, producer-closed, participant-left, …).
    this.onNotification({ type: msg.type, payload: msg.payload });
  }

  // Send `{ type, id, payload }` and await the matching `<type>:response`.
  request<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type, id, payload }));
    });
  }
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id) as HTMLElement;
function log(line: string): void {
  const el = $('log');
  if (el) el.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${el.textContent}`;
  console.log('[dev]', line);
}
function show(field: string, value: string): void {
  const el = $(field);
  if (el) el.textContent = value;
}

// Module-scoped handles so the bytesReceived poller and the new-producer handler
// can reach the recv transport / device after join completes.
let device: Device;
let sendTransport: Transport;
let recvTransport: Transport;
const consumers = new Map<string, Consumer>();
const producers: Producer[] = [];
let signal: SignalClient;

// ── The full harness flow ────────────────────────────────────────────────────
export async function start(): Promise<void> {
  const wssUrl = (($('wssUrl') as HTMLInputElement).value || '').trim();
  const mediaRoomId = (($('mediaRoomId') as HTMLInputElement).value || 'dev-room').trim();
  const participantId = (($('participantId') as HTMLInputElement).value || `peer-${Math.random().toString(36).slice(2, 8)}`).trim();
  const secret = (($('devSecret') as HTMLInputElement).value || '').trim();
  // GATE 2 toggle — when ON, every candidate is forced through coturn (turns:/443).
  const forceRelay = ($('forceRelay') as HTMLInputElement).checked;
  const iceTransportPolicy: RTCIceTransportPolicy | undefined = forceRelay ? 'relay' : undefined;

  log(`connecting to ${wssUrl} as ${participantId} (forceRelay=${forceRelay})`);
  signal = new SignalClient();
  signal.onNotification = note => void onNotification(note).catch(e => log(`notification error: ${e.message}`));
  await signal.connect(wssUrl);

  // 1. join (dev-secret) → the reply carries rtpCapabilities + iceServers + existingProducers.
  const joined = await signal.request('join', { mediaRoomId, participantId, secret });
  log('joined media room');
  // iceServers (the freshly-minted coturn HMAC creds) come from the joined response (TURN-03).
  const iceServers = joined.iceServers as RTCIceServer[];
  show('iceServerCount', String(iceServers?.length ?? 0));

  // 2. device.load with the Router's rtpCapabilities.
  device = new Device();
  await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
  log('device loaded');

  // 3. createSendTransport / createRecvTransport — iceServers wired from joined,
  //    iceTransportPolicy: 'relay' applied when the force-relay toggle is on (GATE 2).
  sendTransport = await createTransport('send', iceServers, iceTransportPolicy);
  recvTransport = await createTransport('recv', iceServers, iceTransportPolicy);

  // 4. getUserMedia → produce(mic) + produce(cam) on the send transport.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  const localVideo = $('localVideo') as HTMLVideoElement;
  localVideo.srcObject = stream;
  await localVideo.play().catch(() => {});

  for (const track of stream.getTracks()) {
    const producer = await sendTransport.produce({ track });
    producers.push(producer);
    log(`producing ${track.kind} (producer ${producer.id})`);
  }

  // 5. Auto-consume any producers that were ALREADY in the room when we joined.
  for (const p of (joined.existingProducers as Array<{ producerId: string; participantId: string }>) ?? []) {
    await consume(p.producerId, p.participantId);
  }

  // GATE 1 + GATE 2 readout: poll recvTransport.getStats() every second and surface
  // the inbound-rtp bytesReceived + the selected candidate-pair type (host/srflx/relay).
  startStatsPoller();
  log('flow complete — watch the bytesReceived readout');
}

async function createTransport(
  direction: 'send' | 'recv',
  iceServers: RTCIceServer[],
  iceTransportPolicy: RTCIceTransportPolicy | undefined,
): Promise<Transport> {
  const params = await signal.request('createWebRtcTransport', { direction });
  const opts = {
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    // iceServers from the joined response; iceTransportPolicy: 'relay' forces coturn.
    iceServers,
    iceTransportPolicy,
  };
  const transport = direction === 'send' ? device.createSendTransport(opts) : device.createRecvTransport(opts);

  // DTLS connect — fired once per transport when the browser produces dtlsParameters.
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    signal
      .request('connectTransport', { transportId: transport.id, dtlsParameters })
      .then(() => callback())
      .catch((e: Error) => errback(e));
  });

  // produce signaling — fired on the SEND transport for each track.
  if (direction === 'send') {
    transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      signal
        .request('produce', { transportId: transport.id, kind, rtpParameters })
        .then((res: { id: string }) => callback({ id: res.id }))
        .catch((e: Error) => errback(e));
    });
  }

  transport.on('connectionstatechange', state => {
    log(`${direction} transport ICE/DTLS state: ${state}`);
    if (direction === 'recv') show('iceState', state);
  });

  return transport;
}

// ── consume → resume → attach ────────────────────────────────────────────────
async function consume(producerId: string, fromParticipant: string): Promise<void> {
  const res = await signal.request('consume', {
    transportId: recvTransport.id,
    producerId,
    rtpCapabilities: device.rtpCapabilities,
  });
  const consumer = await recvTransport.consume({
    id: res.id,
    producerId: res.producerId,
    kind: res.kind,
    rtpParameters: res.rtpParameters,
  });
  consumers.set(consumer.id, consumer);

  // Attach the remote track to a media element, then RESUME (server created the
  // consumer paused: true — we resume only after attach to avoid first-keyframe loss).
  attachTrack(consumer, fromParticipant);
  await signal.request('resume', { consumerId: consumer.id });
  log(`consuming ${consumer.kind} from ${fromParticipant} (resumed)`);
}

function attachTrack(consumer: Consumer, fromParticipant: string): void {
  const stream = new MediaStream([consumer.track]);
  if (consumer.kind === 'video') {
    const remote = $('remoteVideo') as HTMLVideoElement;
    remote.srcObject = stream;
    void remote.play().catch(() => {});
  } else {
    const remote = $('remoteAudio') as HTMLAudioElement;
    remote.srcObject = stream;
    void remote.play().catch(() => {});
  }
  show('remotePeer', fromParticipant);
}

// ── Broadcast handler — auto-consume new producers, drop closed ones ───────────
async function onNotification(note: Notification): Promise<void> {
  switch (note.type) {
    case 'new-producer': {
      const { producerId, participantId } = note.payload as { producerId: string; participantId: string };
      log(`new-producer ${producerId} from ${participantId} — consuming`);
      await consume(producerId, participantId);
      break;
    }
    case 'producer-closed':
    case 'participant-left': {
      log(`${note.type}: ${JSON.stringify(note.payload)}`);
      break;
    }
    default:
      log(`notification: ${note.type}`);
  }
}

// ── GATE 1/2 READOUT — bytesReceived via recvTransport.getStats() ──────────────
// The single acceptance signal: inbound-rtp bytesReceived climbing above 0 means
// REAL RTP is flowing (not merely "ICE connected"). Also surface the selected
// candidate-pair type so a forced-relay run shows `relay` (GATE 2).
function startStatsPoller(): void {
  setInterval(async () => {
    if (!recvTransport) return;
    const stats = await recvTransport.getStats();
    let totalBytes = 0;
    let pairType = '';
    const candidateById = new Map<string, any>();
    stats.forEach((report: any) => {
      if (report.type === 'inbound-rtp') {
        totalBytes += report.bytesReceived ?? 0;
      }
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidateById.set(report.id, report);
      }
    });
    // Find the nominated/selected candidate pair to read host/srflx/relay.
    stats.forEach((report: any) => {
      if (report.type === 'candidate-pair' && (report.nominated || report.selected)) {
        const local = candidateById.get(report.localCandidateId);
        const remote = candidateById.get(report.remoteCandidateId);
        pairType = `${local?.candidateType ?? '?'} ↔ ${remote?.candidateType ?? '?'}`;
      }
    });
    // PASS CRITERION: bytesReceived > 0 and increasing.
    show('bytesReceived', String(totalBytes));
    if (pairType) show('candidatePair', pairType);
  }, 1000);
}
