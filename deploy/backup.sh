#!/usr/bin/env bash
#
# Back up a story-core deployment: the SQLite database (accounts, quotas,
# credits, market) and every user's library under data/.
#
# The archive also contains .env, because a backup that cannot restore the model
# configuration is not a disaster-recovery artifact. Both the database (password
# hashes) and .env (API key) are secrets, so the archive is written mode 600 and
# must not be published anywhere.
#
# Consistency: this is a plain file copy taken while the service may be writing.
# SQLite journals through the WAL, which is included, so a restored database
# replays or rolls back exactly as it would after a power loss. For a snapshot
# that is clean by construction, stop the stack first:
#   docker compose down && ./backup.sh && docker compose up -d
set -euo pipefail

cd "$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="backups/story-core-${STAMP}.tar.gz"
PARTIAL="${ARCHIVE}.partial"
KEEP="${BACKUP_KEEP:-14}"

if [ ! -d data ]; then
  echo "Error: no ./data directory next to this script; is this a story-core deployment?" >&2
  exit 1
fi

mkdir -p backups
chmod 700 backups

# Write to .partial first so an interrupted run can never leave a truncated file
# that looks like a valid archive.
tar --create --gzip --file "$PARTIAL" --exclude='*.partial' data
[ -f .env ] && tar --append --file "$PARTIAL" .env

chmod 600 "$PARTIAL"
mv "$PARTIAL" "$ARCHIVE"
sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"
chmod 600 "$ARCHIVE" "${ARCHIVE}.sha256"

# Rotation: keep the newest $KEEP archives.
kept=0
while IFS= read -r file; do
  kept=$((kept + 1))
  if [ "$kept" -gt "$KEEP" ]; then
    rm -f "$file" "${file}.sha256"
  fi
done < <(ls -1t backups/story-core-*.tar.gz 2>/dev/null || true)

echo "$ARCHIVE"
