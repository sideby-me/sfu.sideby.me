// Centralized SFU configuration — all env vars are read ONCE at module load.
// Mirrors the lens.sideby.me env-read idiom (`Number(process.env.X ?? default)` /
// `process.env.X ?? ''`) but consolidated into a single typed `config` object.
import fs from 'fs';
import dotenv from 'dotenv';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
}
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // D-03: MEDIASOUP_ANNOUNCED_IP is hard-required with no default — never
    // boot-time auto-detect. Throw loudly so a misconfigured droplet fails fast.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface SfuConfig {
  /** Public IP advertised in ICE candidates (D-03). Required, no default. */
  announcedIp: string;
  /**
   * Optional private/VPC IP for the co-located coturn relay leg (D-01). coturn
   * refuses to relay to its own public IP (which the co-located SFU shares), so when
   * this is set the WebRtcServer advertises a SECOND candidate BOUND to this private
   * IP — coturn (bound to public+loopback only) will relay there, and the SFU's return
   * packets carry the private source IP coturn has permission for. Empty = single
   * (public) candidate only.
   */
  privateIp: string;
  /** Base UDP/TCP port for the per-worker WebRtcServer shared port. */
  rtcBasePort: number;
  /** Dev shared-secret gating the WS join (Phase-1 placeholder; Phase 2 → HS256). */
  devSecret: string;
  /** Server-to-server secret gating the admin HTTP surface (X-Sfu-Secret). */
  adminSecret: string;
  /** Shared static-auth-secret for coturn HMAC credential minting. */
  turnStaticAuthSecret: string;
  /** Public hostname clients reach coturn on (e.g. turn.sideby.me). */
  turnPublicHost: string;
  /**
   * TLS cert/key paths for the WSS backend (D-06). The nginx SNI router does NOT
   * terminate TLS — it ssl_preread-forwards the raw stream, so the SFU backend owns
   * its own TLS. When both are set, the gateway listens https; otherwise plain http
   * (local dev). Empty by default.
   */
  tlsCertPath: string;
  tlsKeyPath: string;
  /** TTL (seconds) for minted TURN credentials. */
  turnCredTtlSec: number;
  /** Max participants per media room (D-11). */
  participantCap: number;
  /** Grace window (ms) before an empty room's router is reclaimed (D-12). */
  reconnectGraceMs: number;
}

export const config: SfuConfig = {
  announcedIp: requireEnv('MEDIASOUP_ANNOUNCED_IP'),
  privateIp: process.env.MEDIASOUP_PRIVATE_IP?.trim() ?? '',
  rtcBasePort: Number(process.env.RTC_BASE_PORT ?? 44444),
  devSecret: process.env.SFU_DEV_SECRET ?? '',
  adminSecret: process.env.SFU_ADMIN_SECRET ?? '',
  turnStaticAuthSecret: process.env.TURN_STATIC_AUTH_SECRET ?? '',
  turnPublicHost: process.env.TURN_PUBLIC_HOST ?? '',
  tlsCertPath: process.env.SFU_TLS_CERT ?? '',
  tlsKeyPath: process.env.SFU_TLS_KEY ?? '',
  turnCredTtlSec: Number(process.env.TURN_CRED_TTL_SEC ?? 3600),
  participantCap: Number(process.env.PARTICIPANT_CAP ?? 8),
  // D-12: grace default = 30000 (top of the 10000–30000 window).
  reconnectGraceMs: Number(process.env.RECONNECT_GRACE_MS ?? 30000),
};
