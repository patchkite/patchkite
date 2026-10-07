#!/bin/sh
# Deploy a Patchkite server image (single host), invoked over SSH by a CI deploy job.
# The CI deploy key is installed in ~/.ssh/authorized_keys with a forced command, so it can only run this script:
#   command="/home/<user>/patchkite/deploy.sh",restrict ssh-ed25519 AAAA... patchkite-ci-deploy
# Argument (from SSH_ORIGINAL_COMMAND or $1): image tag, e.g. `0.2.0`.
# Flow: pull image → backup → replace PATCHKITE_IMAGE in .env → restart server → wait for healthy,
# or roll back to the previous image if the server is not healthy.
set -eu
umask 077  # .env contains database and S3 passwords

DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"
TAG=${1:-${SSH_ORIGINAL_COMMAND:-}}
case "$TAG" in
  "" | *[!0-9A-Za-z._-]*) echo "Invalid image tag: '$TAG'" >&2; exit 2 ;;
esac
NEW="${PATCHKITE_REPO:-ghcr.io/patchkite/server}:$TAG"
OLD=$(sed -n 's/^PATCHKITE_IMAGE=//p' .env)

log() { echo "[$(date -u +%FT%TZ)] $*"; }
set_image() {
  { grep -v '^PATCHKITE_IMAGE=' .env || true; echo "PATCHKITE_IMAGE=$1"; } > .env.new
  cat .env.new > .env && rm .env.new  # rewrite contents, keeping .env file permissions
}
wait_healthy() {
  for _ in $(seq 1 60); do
    id=$(sudo -n docker compose ps -q server)
    [ -n "$id" ] && [ "$(sudo -n docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ] && return 0
    sleep 2
  done
  return 1
}

if [ "$NEW" = "$OLD" ]; then log "$NEW is already running"; exit 0; fi
log "pull $NEW"
sudo -n docker pull -q "$NEW"
log "backup before deploy"
sudo -n ./backup.sh

set_image "$NEW"
sudo -n docker compose up -d server
if wait_healthy; then
  log "deploy $NEW succeeded (previously $OLD)"
  exit 0
fi

log "server not healthy, rolling back to $OLD"
sudo -n docker compose logs --tail 50 server || true
set_image "$OLD"
sudo -n docker compose up -d server
wait_healthy || log "previous image is not healthy either, check the server manually"
exit 1
