#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# certbot-deploy-hook.sh — run by certbot on successful cert renewal.
#
# Wire it as:  certbot renew --deploy-hook /path/to/certbot-deploy-hook.sh
# (or drop it in /etc/letsencrypt/renewal-hooks/deploy/).
#
# certbot sets $RENEWED_DOMAINS + $RENEWED_LINEAGE on each invocation. This hook
# fires for renewals of either subdomain (turn.sideby.me, sfu.sideby.me).
#
# CRITICAL (Pitfall 7 — CORRECTION): coturn hot-reloads its TLS cert ONLY on the
# USR2 signal — never the config-reload signal. Sending the wrong signal leaves
# coturn serving the OLD (post-renewal: expired) cert, and after ~90 days strict
# clients drop the turns: handshake. We therefore `docker kill -s USR2` the coturn
# container (no relay interruption — coturn re-reads the cert files in place).
# Falling back to a container restart is acceptable but causes a brief relay blip.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

COTURN_CONTAINER="${COTURN_CONTAINER:-sfu-coturn-1}"
SFU_CONTAINER="${SFU_CONTAINER:-sfu-sfu-1}"

log() { printf '[certbot-deploy-hook] %s\n' "$*"; }

# 1. Reload coturn's TLS cert in place via the USR2 signal (NOT the config-reload signal).
if docker ps --format '{{.Names}}' | grep -qx "${COTURN_CONTAINER}"; then
  log "signaling coturn (${COTURN_CONTAINER}) USR2 to hot-reload turns: cert"
  docker kill -s USR2 "${COTURN_CONTAINER}"
else
  log "WARN: coturn container ${COTURN_CONTAINER} not running — skipping cert reload"
fi

# 2. Restart the SFU so its WSS backend picks up the renewed sfu.sideby.me cert. The
#    SFU terminates its OWN TLS (the nginx SNI router does NOT — D-06), and the Node
#    https server reads the cert files only at boot, so a restart is required (a brief
#    new-connection blip; existing media transports are unaffected). nginx-sni holds no
#    cert (pure ssl_preread passthrough), so it needs no reload here.
if docker ps --format '{{.Names}}' | grep -qx "${SFU_CONTAINER}"; then
  log "restarting SFU (${SFU_CONTAINER}) to reload sfu.sideby.me WSS cert"
  docker restart "${SFU_CONTAINER}"
else
  log "WARN: SFU container ${SFU_CONTAINER} not running — skipping WSS cert reload"
fi

log "deploy-hook complete for: ${RENEWED_DOMAINS:-<unknown>}"
