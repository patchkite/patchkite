#!/bin/sh
# Pull-based deploy for a single host: find the newest stable server image on GHCR and, if it is newer
# than the running one, hand it to deploy.sh (pull → backup → restart → health check → rollback on failure).
# Run by patchkite-update.timer (see systemd/). Needs no inbound access, so it works on a VM behind a VPN.
# Install (once, on the host):
#   echo COMPOSE_FILE=docker-compose.selfhost.yml >> .env   # deploy.sh runs plain `docker compose`
#   sudo cp docker/systemd/patchkite-update.* /etc/systemd/system/   # edit User and path first
#   sudo systemctl daemon-reload && sudo systemctl enable --now patchkite-update.timer
#   journalctl -u patchkite-update.service   # see what it did
# Pre-release tags (1.2.0-rc.1) and `latest` are ignored. Never downgrades.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"
REPO=${PATCHKITE_REPO:-ghcr.io/patchkite/server}
NAME=${REPO#ghcr.io/}

exec 9>.auto-update.lock
flock -n 9 || { echo "another update is running"; exit 0; }

TOKEN=$(curl -fsS "https://ghcr.io/token?service=ghcr.io&scope=repository:$NAME:pull" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "could not get a GHCR token" >&2; exit 1; }

LATEST=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/$NAME/tags/list" |
  grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sort -V | tail -1)
[ -n "$LATEST" ] || { echo "no release tags found for $REPO" >&2; exit 1; }

CURRENT=$(sed -n 's/^PATCHKITE_IMAGE=//p' .env | sed -n 's/.*:\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
if [ -n "$CURRENT" ] && [ "$(printf '%s\n%s\n' "$CURRENT" "$LATEST" | sort -V | tail -1)" = "$CURRENT" ]; then
  echo "up to date ($CURRENT)"
  exit 0
fi

echo "updating ${CURRENT:-unknown} → $LATEST"
exec ./deploy.sh "$LATEST"
