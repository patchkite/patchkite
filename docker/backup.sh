#!/bin/sh
# Daily Patchkite backup (single host): PostgreSQL database and RustFS volume.
# Install in root's cron, e.g. /etc/cron.d/patchkite-backup:
#   30 2 * * * root /home/<user>/patchkite/backup.sh >> /home/<user>/patchkite/backups/backup.log 2>&1
set -eu
umask 077  # dumps contain password hashes and access keys

DIR=$(cd "$(dirname "$0")" && pwd)
OUT="$DIR/backups"
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date +%F-%H%M)
mkdir -p "$OUT"
cd "$DIR"

echo "[$(date -Is)] starting backup"
docker compose exec -T postgres pg_dump -U patchkite -Fc patchkite > "$OUT/db-$STAMP.dump.tmp"
mv "$OUT/db-$STAMP.dump.tmp" "$OUT/db-$STAMP.dump"

# The storage volume is mounted read-only; blob contents never change (named by hash).
docker run --rm -v patchkite_s3data:/data:ro -v "$OUT":/backup alpine \
  tar czf "/backup/s3-$STAMP.tar.gz.tmp" -C /data .
mv "$OUT/s3-$STAMP.tar.gz.tmp" "$OUT/s3-$STAMP.tar.gz"

find "$OUT" -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$OUT" -name 's3-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "[$(date -Is)] done: $(du -sh "$OUT/db-$STAMP.dump" | cut -f1) db, $(du -sh "$OUT/s3-$STAMP.tar.gz" | cut -f1) storage"
