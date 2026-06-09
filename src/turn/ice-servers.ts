// coturn HMAC iceServers mint (TURN-02, TURN-03).
//
// [VERIFIED against the coturn wiki — turnserver `use-auth-secret` / "TURN REST API"]
// coturn's long-term-credential REST scheme: the server holds a single
// `static-auth-secret`; clients are handed a TIME-LIMITED username/credential pair
//   username   = `<unix-expiry>[:<arbitrary-id>]`
//   credential = base64( HMAC-SHA1( static-auth-secret, username ) )
// coturn recomputes the same HMAC server-side and accepts the credential until the
// embedded expiry passes. No per-user state lives on coturn; the shared secret is
// the only coupling (it MUST match `static-auth-secret` in turnserver.conf).
//
// SECURITY (Pitfall 3 / T-01-10): these creds are minted per-join and returned ONLY
// inside the `joined` signaling response. They are NEVER static, NEVER served from a
// separate HTTP endpoint, and NEVER baked into client code — a leaked/static cred is
// an open relay. TTL is bounded by TURN_CRED_TTL_SEC.
import { createHmac } from 'node:crypto';
import type { IceServer } from './types.js';
import { config } from '../config.js';
import { emitTurnCredentialIssued } from '../telemetry/events.js';

/**
 * Mint the time-limited coturn ICE server set for an opaque participant.
 *
 * The returned array is handed to the client verbatim inside the `joined` response.
 * Every turn/turns entry shares one (username, credential) pair derived from a single
 * HMAC over `<expiry>:<participantId>` — coturn validates it against its matching
 * `static-auth-secret`. stun needs no credential.
 *
 * @param participantId opaque participant key (NO product identifier)
 */
export function buildIceServers(participantId: string): IceServer[] {
  const expiry = Math.floor(Date.now() / 1000) + config.turnCredTtlSec;
  const username = `${expiry}:${participantId}`;
  // base64(HMAC-SHA1(static-auth-secret, username)) — the coturn REST-API formula.
  const credential = createHmac('sha1', config.turnStaticAuthSecret).update(username).digest('base64');

  const host = config.turnPublicHost;

  emitTurnCredentialIssued();

  return [
    // STUN needs no credential — pure reflexive-candidate discovery.
    { urls: `stun:${host}:443` },
    // TURN over UDP (primary relay path) and TCP (UDP-blocked networks), then TURNS
    // (TLS, port 443) for the most restrictive networks. All on :443 to look like
    // ordinary HTTPS and survive aggressive egress firewalls.
    { urls: `turn:${host}:443?transport=udp`, username, credential },
    { urls: `turn:${host}:443?transport=tcp`, username, credential },
    { urls: `turns:${host}:443?transport=tcp`, username, credential },
  ];
}
