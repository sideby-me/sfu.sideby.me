# SFU dev harness (D-09) — throwaway phase-done gate driver

This `dev/` directory is a **throwaway validation artifact**, NOT production code and
NOT the Phase-3 `@sideby/media-sdk`. It is a raw `mediasoup-client` HTML + TS smoke
test whose only job is to drive the Phase-1 phase-done gates against the deployed SFU.

> **It is excluded from the production build.** The root `tsconfig.json` compiles only
> `src/**/*.ts` (`"include": ["src/**/*.ts"]`), and the production Docker image copies
> only `dist/` + `node_modules`. Nothing in `dev/` is ever shipped (threat T-01-25).
> Do not import anything from `dev/` into `src/`.

## What it proves (the two acceptance signals that matter)

| Gate | Success criterion | What the page does |
|------|-------------------|--------------------|
| **GATE 1** | #1 — cross-network media | Two clients on **different public networks** show `bytesReceived > 0` on the recv transport (the `announcedAddress` / host-networking media gate — ICE "connected" but zero bytes is the #1 mediasoup failure mode). |
| **GATE 2** | #2 — forced relay | The **force-relay** toggle sets `iceTransportPolicy: 'relay'`, forcing every candidate through coturn; media still flows over `turns:`/443 from a UDP-blocked network. |
| **GATE 3** | #5 — observability | Run a call, then confirm the SFU's join/produce/consume/close + ICE state + bytes-received + relay-vs-direct ratio show up in `trace.sideby.me`. |

## Running it

The page imports `mediasoup-client` (already a dependency in the SFU `package.json`)
and loads `client.ts` as a browser ES module, so it must be **bundled** — browsers
cannot resolve the bare `mediasoup-client` import or strip TS types on their own.

The simplest one-liner (no config, serves + bundles + live-reloads on `:5173`):

```bash
# from sfu.sideby.me/
npx --yes vite dev --port 5173 dev
# then open http://localhost:5173/index.html
```

Or with esbuild's built-in dev server:

```bash
# from sfu.sideby.me/
npx --yes esbuild dev/client.ts --bundle --servedir=dev --outfile=dev/client.js
# then open http://localhost:8000/  (esbuild prints the port)
```

> `getUserMedia` requires a **secure context** — `localhost` is treated as secure, so
> the local dev server is fine. When testing the real cross-network gate you point the
> page at `wss://sfu.sideby.me` and the page itself is served over `https`/`localhost`.

## Fields & the dev secret

| Field | Meaning |
|-------|---------|
| **WSS URL** | The SFU signaling endpoint, e.g. `wss://sfu.sideby.me` (the nginx SNI router forwards `sfu.sideby.me` → the plain WSS backend on `:8443`). |
| **mediaRoomId** | An **opaque** room key. Both tabs/devices must use the SAME value to be in one call. Never a sideby product identifier (SFU-02). |
| **participantId** | An **opaque** per-client key (auto-generated if left blank). Each client must use a DIFFERENT value. |
| **dev secret** | The Phase-1 join gate — must equal the SFU's `SFU_DEV_SECRET` env var. Leave blank only if the SFU was started with `SFU_DEV_SECRET` unset (dev-open). This is the coarse Phase-1 placeholder; Phase 2 swaps in HS256 at the single `verifyJoin` seam (D-10). |
| **force-relay** | When checked, passes `iceTransportPolicy: 'relay'` to both transports — GATE 2. |

## The pass criterion

1. Open the page in **two tabs** (quick sanity) OR on a **laptop (home wifi) + a phone
   on cellular/hotspot** — a genuinely DIFFERENT public network (the real GATE 1).
2. Enter the same **mediaRoomId** and the **dev secret** on both; click **Start**.
3. Grant camera + mic; each side produces mic + cam and auto-consumes the other.
4. **Watch the `bytesReceived` readout.**

> **PASS = `bytesReceived > 0` and climbing on BOTH sides.**
>
> If ICE shows `connected` but `bytesReceived` stays `0`, the `announcedAddress` /
> host-networking config is wrong (Pitfall 1) — re-check `MEDIASOUP_ANNOUNCED_IP`
> (must be the droplet's static public IP) and `network_mode: host` on the compose
> stack. ICE "connected" is NOT the gate; bytes flowing is.

### GATE 2 (forced relay)

Check **force-relay**, re-run, and confirm `bytesReceived > 0` still climbs. The
`selected candidate pair` readout should show `relay`. To prove `turns:`/443
specifically, run the force-relay call from a genuinely UDP-blocked / 443-only network
(e.g. a restrictive corporate/guest wifi) — the `turns:turn.sideby.me:443` candidate
must connect.

### GATE 3 (observability)

After a call, open `trace.sideby.me` / ClickHouse and confirm the SFU spans/metrics for
`join` / `produce` / `consume` / `close`, ICE state, bytes-received, and the
relay-vs-direct ratio are present (and that `worker_died` is emitted on a worker death).
