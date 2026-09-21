#!/usr/bin/env bash
# Interop acceptance check: prove that SillyTavern itself can read a character
# card written by this project.
#
#   ./scripts/verify-with-sillytavern.sh [card-id] [options]
#
# Options:
#   --library DIR       library to export from (default: $MINI_DIR/data/default-user)
#   --story-tavern DIR  the story-tavern checkout, for its compose file and data
#   --container NAME    use an existing container instead of asking compose
#
# It exports a card with this project's writer, copies it into the running
# SillyTavern, and parses it with SillyTavern's own src/character-card-parser.js
# inside that container. Both parsers must agree on the character name.
#
# Files move with `docker cp` rather than through a bind mount, so this works
# against any SillyTavern container, including a bare `docker run` in CI.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CARD_ID=""
MINI_DIR="$(cd -- "$ROOT_DIR/../story-tavern" 2>/dev/null && pwd || true)"
CONTAINER=""
LIBRARY=""

while (( $# > 0 )); do
  case "$1" in
    --story-tavern) MINI_DIR="${2:-}"; shift 2 ;;
    --library)      LIBRARY="${2:-}"; shift 2 ;;
    --container)    CONTAINER="${2:-}"; shift 2 ;;
    *)              CARD_ID="$1"; shift ;;
  esac
done

if [[ -z "$LIBRARY" ]]; then
  [[ -n "$MINI_DIR" && -d "$MINI_DIR/data/default-user" ]] || {
    echo "Error: pass --library DIR (or --story-tavern DIR with an installed tavern)." >&2
    exit 1
  }
  LIBRARY="$MINI_DIR/data/default-user"
fi

[[ -d "$LIBRARY/characters" ]] || {
  echo "Error: $LIBRARY/characters does not exist." >&2
  exit 1
}

if [[ -z "$CONTAINER" ]]; then
  [[ -n "$MINI_DIR" && -f "$MINI_DIR/docker-compose.yml" ]] || {
    echo "Error: pass --container NAME, or --story-tavern DIR to find it through compose." >&2
    exit 1
  }
  CONTAINER="$(docker compose -f "$MINI_DIR/docker-compose.yml" ps -q sillytavern 2>/dev/null || true)"
  [[ -n "$CONTAINER" ]] || {
    echo "Error: the sillytavern container is not running (start it with $MINI_DIR/scripts/install.sh)." >&2
    exit 1
  }
fi

docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "Error: no such container: $CONTAINER" >&2
  exit 1
}

if [[ -z "$CARD_ID" ]]; then
  CARD_ID="$(STORY_LIBRARY_ROOT="$LIBRARY" node --disable-warning=ExperimentalWarning src/cli.ts list | awk 'NR==1 {print $1}')"
fi

[[ -n "$CARD_ID" ]] || {
  echo "Error: no character card found in $LIBRARY/characters." >&2
  exit 1
}

WORK_DIR="$(mktemp -d)"
CARDS_DIR="/home/node/app/data/default-user/characters"
PROBE_CARD="$CARDS_DIR/story-roundtrip.png"
PROBE_SCRIPT="/home/node/app/data/_story_verify.mjs"

# Invoked indirectly through `trap ... EXIT` below, which ShellCheck does not
# always follow (SC2329).
# shellcheck disable=SC2329
cleanup() {
  docker exec "$CONTAINER" rm -f "$PROBE_CARD" "$PROBE_SCRIPT" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "1. exporting '$CARD_ID' with this project's writer..."
STORY_LIBRARY_ROOT="$LIBRARY" node --disable-warning=ExperimentalWarning \
  src/cli.ts export "$CARD_ID" "$WORK_DIR/story-roundtrip.png"

OUR_NAME="$(STORY_LIBRARY_ROOT="$LIBRARY" node --disable-warning=ExperimentalWarning src/cli.ts show "$CARD_ID" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["name"])')"
echo "   our parser says: name=$OUR_NAME"

cat > "$WORK_DIR/verify.mjs" <<'SCRIPT'
import fs from 'node:fs';
import { read as readCard } from '../src/character-card-parser.js';

const card = JSON.parse(readCard(fs.readFileSync(process.argv[2])));
console.log(JSON.stringify({
    name: (card.data ?? card).name,
    spec: card.spec ?? '(v1)',
    descriptionLength: ((card.data ?? card).description ?? '').length,
}));
SCRIPT

echo "2. handing the file to SillyTavern ($CONTAINER)..."
docker exec "$CONTAINER" mkdir -p "$CARDS_DIR"
docker cp "$WORK_DIR/story-roundtrip.png" "$CONTAINER:$PROBE_CARD" >/dev/null
docker cp "$WORK_DIR/verify.mjs" "$CONTAINER:$PROBE_SCRIPT" >/dev/null

RAW_OUTPUT="$(docker exec "$CONTAINER" node "$PROBE_SCRIPT" "$PROBE_CARD" 2>&1 | tail -1)"
echo "   SillyTavern says: $RAW_OUTPUT"

ST_NAME="$(printf '%s' "$RAW_OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"

echo
if [[ "$ST_NAME" == "$OUR_NAME" ]]; then
  echo "PASS: SillyTavern read the card this project wrote (name=$ST_NAME)."
  exit 0
fi

echo "FAIL: SillyTavern read '$ST_NAME' but this project wrote '$OUR_NAME'." >&2
exit 1
