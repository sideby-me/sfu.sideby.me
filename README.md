# sfu.sideby.me

Product-agnostic mediasoup SFU + self-hosted coturn. Knows nothing about sideby
rooms/users — operates on generic rooms + participants keyed by **opaque IDs** only.
This service stands up the media plane (mediasoup SFU over host networking) and the
TURN/STUN relay (coturn behind an nginx SNI router on `:443`).

> **Deployment shape (D-01/D-02):** the SFU + coturn co-locate on **one new dedicated
> droplet** as an independent service root. NEVER co-locate them on the lens or sync
> droplets. Single-instance is in scope for this phase.

---

## Architecture (deploy stack)

Three containers, all `network_mode: host` + `init: true` (tini PID-1), no bridge
port mapping (`docker-compose.yml`):

| Container   | Role                                   | Listens on (host)                                  |
| ----------- | -------------------------------------- | -------------------------------------------------- |
| `sfu`       | mediasoup SFU + raw-`ws` signaling     | WSS backend `8443`; RTC `rtcBasePort..+workers` (UDP+TCP); admin internal |
| `coturn`    | TURN/STUN relay (`coturn/coturn:4.11.0`) | `3478` (turn/stun), `5349` (turns: TLS), `49152-65535/udp` (relay) |
| `nginx-sni` | SNI router (`nginx:1.27`)              | `443` (ssl_preread, routes by SNI — NO TLS termination) |

**SNI routing (`nginx-sni.conf`):** the router peeks the TLS ClientHello SNI and
proxies the **raw TLS stream** (it does NOT terminate TLS):

- `sfu.sideby.me`  → `127.0.0.1:8443` (WSS backend terminates its own TLS — RESEARCH Q1)
- `turn.sideby.me` → `127.0.0.1:5349` (coturn `turns:` terminates its own TLS)

Why host networking is MANDATORY: the Docker bridge / userland-proxy rewrites the
source/dest IPs ICE relies on, so containers behind a bridge advertise unroutable ICE
candidates and **no RTP flows** (the #1 mediasoup pitfall). Host networking + a static
`MEDIASOUP_ANNOUNCED_IP` is the precondition for `bytesReceived > 0`.

---

## Phase-done gates

This phase is **done** only when both gates are green from a client on a different
public network (e.g. a phone on cellular, NOT localhost):

1. **`bytesReceived > 0` cross-network.** Two peers on different public networks
   produce/consume audio+video and the consuming side's `RTCInboundRtpStreamStats.bytesReceived`
   climbs above zero. This proves `announcedAddress` + host networking advertise a
   routable ICE candidate and real RTP flows end-to-end. ICE reaching `connected`
   with 0 bytes is the classic announcedAddress failure — it does NOT count.

2. **Forced-relay over `turns:`/443.** With the client forced to
   `iceTransportPolicy: 'relay'`, media still flows through coturn over `turns:` on
   `443`. This proves coturn's TLS relay works for the most restrictive (UDP-blocked,
   egress-filtered) networks. Verify from a network that blocks UDP.

The dev harness (`dev/client.ts`, raw `mediasoup-client` — NOT the Phase-3 SDK) drives
both: a force-relay toggle and a `getStats()` `bytesReceived` readout.

---

## Let's Encrypt cert issuance (both subdomains)

certbot must issue certs for **both** `sfu.sideby.me` AND `turn.sideby.me`. The SNI
router owns `:443`, so HTTP-01's default `:443` challenge is unavailable — use one of:

- **DNS-01 (recommended):** issue via your DNS provider's API. No port juggling; works
  even with `:443` and `:80` occupied. Best for a wildcard or multi-subdomain cert.
- **HTTP-01 on `:80`:** the SNI router owns `:443` but `:80` is typically free, so
  standalone certbot on `:80` works:
  `certbot certonly --standalone -d sfu.sideby.me -d turn.sideby.me`.

Mount the issued cert into coturn at `/etc/coturn/certs/turn.sideby.me/`
(see `docker-compose.yml`). The WSS terminator reads the `sfu.sideby.me` cert.

**Renewal hook (Pitfall 7):** wire `scripts/certbot-deploy-hook.sh` as the
`--deploy-hook`. On renewal it signals **coturn `SIGUSR2`** (`docker kill -s USR2`) to
hot-reload the `turns:` cert in place — coturn reloads its cert on `SIGUSR2`, never the
config-reload signal; sending the wrong signal serves an expired cert after ~90 days and
strict clients drop. The hook also reloads the WSS terminator. Example:

```bash
certbot renew --deploy-hook /app/scripts/certbot-deploy-hook.sh
```

Note: Let's Encrypt cert files are root-readable only by default (coturn issue #268) —
ensure the mounted cert path is readable by the coturn container/user.

---

## Cross-host OTLP transport security (D-13)

The OTLP endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`) is on a **separate box** (the
trace.sideby.me droplet), reached over the network — NOT `localhost`. Media incidents
are NAT-dependent and intermittent (the hardest class to debug), so OTEL is on from day
one — but telemetry must not transit the public internet in plaintext. Choose one:

- **DigitalOcean VPC private networking (recommended, same region):** point
  `OTEL_EXPORTER_OTLP_ENDPOINT` at the trace box's **private** VPC address. Simplest;
  no public exposure, no extra auth.
- **OTLP over HTTPS with a bearer header:** if the boxes are in different regions, use
  an `https://` endpoint and set `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>`
  (the telemetry bootstrap already parses this header).

**NEVER** export OTLP over plain HTTP across the public internet. Telemetry emit is
fail-open — if the endpoint is unset or unreachable, the SFU boots and runs normally.

---

## Host firewall — ports to open

Open exactly these on the droplet firewall:

| Port / range                    | Proto    | Purpose                                              |
| ------------------------------- | -------- | ---------------------------------------------------- |
| `443`                           | TCP      | nginx SNI router (fronts WSS + `turns:`)             |
| `80`                            | TCP      | HTTP-01 cert challenge (only if using HTTP-01)       |
| `3478`                          | UDP+TCP  | coturn plain `turn:`/`stun:`                          |
| `rtcBasePort .. rtcBasePort+workers` | UDP+TCP | mediasoup WebRtcServer shared ports (one per worker) |
| `49152-65535`                   | UDP      | coturn relay allocation range                        |

**Do NOT** expose the SFU admin/health port (`SFU_ADMIN_PORT`, default
`rtcBasePort - 1`). It is INTERNAL — the LB health check and ops reach it directly,
the public SNI router never forwards it. Firewall it off the public internet. The
deploy gate polls `GET /readiness` (200 only when the mediasoup worker pool is up).

**Cost watch (D-04):** the variable cost to monitor is **DigitalOcean egress
bandwidth** through the coturn relay — NOT CPU. Forced-relay traffic transits coturn,
so a busy room over `turns:` is a bandwidth (not compute) cost. `total-quota` in
`turnserver.conf` bounds concurrent allocations.

---

## Local development

```bash
npm install
npm run dev        # tsx --watch src/index.ts
npm run build      # tsc -> dist
npm run typecheck  # tsc --noEmit (authoritative typecheck runs in the Docker build stage)
npm run test       # vitest
```

Set at minimum `MEDIASOUP_ANNOUNCED_IP` (hard-required, no default) in `.env` — see
`.env.example`. For a real cross-network gate test you need the deployed droplet
(host networking + a public IP); localhost only proves the signaling/produce/consume
loop, not the announcedAddress/relay gates.

---

## Files

| File                          | Role                                                         |
| ----------------------------- | ----------------------------------------------------------- |
| `Dockerfile`                  | Multi-stage Node22 build (mediasoup worker deps) → runtime  |
| `docker-compose.yml`          | sfu + coturn + nginx-sni, host networking + init/tini       |
| `turnserver.conf`             | coturn HMAC auth + `turns:` TLS + relay range + hardening   |
| `nginx-sni.conf`              | `stream` + `ssl_preread` SNI router (no TLS termination)    |
| `scripts/certbot-deploy-hook.sh` | SIGUSR2 coturn cert reload on renewal                    |
