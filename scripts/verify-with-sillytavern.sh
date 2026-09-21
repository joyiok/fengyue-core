#!/usr/bin/env bash
# M0 acceptance check: prove that SillyTavern itself can read a character card
# written by this project.
#
#   ./scripts/verify-with-sillytavern.sh [card-id] [--story-tavern DIR]
#
# It exports a card with this project's writer, drops the result into the running
# SillyTavern's character directory, and parses it with SillyTavern's own
# src/character-card-parser.js inside the container. Both parsers must agree.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CARD_ID=""
MINI_DIR="$(cd -- "$ROOT_DIR/../story-tavern" 2>/dev/null && pwd || true)"

while (( $# > 0 )); do
  case "$1" in
    --story-tavern)
      MINI_DIR="${2:-}"
      shift 2
      ;;
    *)
      CARD_ID="$1"
      shift
      ;;
  esac
done

[[ -n "$MINI_DIR" && -f "$MINI_DIR/docker-compose.yml" ]] || {
  echo "Error: point --story-tavern at the story-tavern checkout (docker-compose.yml not found)." >&2
  exit 1
}

LIBRARY_ROOT="$MINI_DIR/data/default-user"
[[ -d "$LIBRARY_ROOT/characters" ]] || {
  echo "Error: $LIBRARY_ROOT/characters does not exist; is the tavern installed?" >&2
  exit 1
}

compose() { docker compose -f "$MINI_DIR/docker-compose.yml" "$@"; }

CONTAINER_ID="$(compose ps -q sillytavern 2>/dev/null || true)"
[[ -n "$CONTAINER_ID" ]] || {
  echo "Error: the sillytavern container is not running (start it with $MINI_DIR/scripts/install.sh)." >&2
  exit 1
}

if [[ -z "$CARD_ID" ]]; then
  CARD_ID="$(STORY_LIBRARY_ROOT="$LIBRARY_ROOT" node src/cli.ts list | awk 'NR==1 {print $1}')"
fi

[[ -n "$CARD_ID" ]] || {
  echo "Error: no character card found in $LIBRARY_ROOT/characters." >&2
  exit 1
}

WORK_DIR="$(mktemp -d)"
STRAY_CARD="$LIBRARY_ROOT/characters/story-roundtrip.png"
STRAY_SCRIPT="$MINI_DIR/data/_story_verify.mjs"

cleanup() {
  rm -rf "$WORK_DIR"
  rm -f "$STRAY_CARD" "$STRAY_SCRIPT"
}
trap cleanup EXIT

echo "1. exporting '$CARD_ID' with this project's writer..."
STORY_LIBRARY_ROOT="$LIBRARY_ROOT" node src/cli.ts export "$CARD_ID" "$WORK_DIR/story-roundtrip.png"

OUR_NAME="$(STORY_LIBRARY_ROOT="$LIBRARY_ROOT" node src/cli.ts show "$CARD_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["name"])')"
echo "   our parser says: name=$OUR_NAME"

echo "2. handing the file to SillyTavern..."
cp "$WORK_DIR/story-roundtrip.png" "$STRAY_CARD"

cat > "$STRAY_SCRIPT" <<'SCRIPT'
import fs from 'node:fs';
import { read as readCard } from '../src/character-card-parser.js';

const file = process.argv[2];
const raw = readCard(fs.readFileSync(file));
const card = JSON.parse(raw);
console.log(JSON.stringify({
    name: (card.data ?? card).name,
    spec: card.spec ?? '(v1)',
    descriptionLength: ((card.data ?? card).description ?? '').length,
}));
SCRIPT

RAW_OUTPUT="$(compose exec -T sillytavern node /home/node/app/data/_story_verify.mjs "/home/node/app/data/default-user/characters/story-roundtrip.png" 2>&1 | tail -1)"
echo "   SillyTavern says: $RAW_OUTPUT"

ST_NAME="$(printf '%s' "$RAW_OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"

echo
if [[ "$ST_NAME" == "$OUR_NAME" ]]; then
  echo "PASS: SillyTavern read the card this project wrote (name=$ST_NAME)."
  exit 0
fi

echo "FAIL: SillyTavern read '$ST_NAME' but this project wrote '$OUR_NAME'." >&2
exit 1
