#!/usr/bin/env bash
# Nightly logical backup of a product database to S3 (production only).
# Needs: pg_dump (PostgreSQL 18 client), aws CLI, and these env vars:
#   OWNER_URL    owner connection string (read access is enough)
#   BACKUP_BUCKET e.g. qavril-backups-prod-qv7k2
#   SERVICE      e.g. platform
set -euo pipefail

: "${OWNER_URL:?set OWNER_URL}"
: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
: "${SERVICE:?set SERVICE}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="/tmp/${SERVICE}-${stamp}.dump"

# Custom format: compressed and restorable with pg_restore, selectively if needed.
pg_dump --format=custom --no-owner --no-acl --file "$file" "$OWNER_URL"

aws s3 cp "$file" "s3://${BACKUP_BUCKET}/${SERVICE}/${stamp}.dump" \
  --sse AES256 --only-show-errors
rm -f "$file"
echo "backed up ${SERVICE} to s3://${BACKUP_BUCKET}/${SERVICE}/${stamp}.dump"
