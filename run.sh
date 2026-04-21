#!/usr/bin/env bash
# run.sh – orchestrator that runs entirely on the host.
#
# 1. Reads one Chrome window's tabs via AppleScript (must run on macOS host).
# 2. Pipes the resulting JSON into the containerised Node app.
#
# Usage:
#   ./run.sh                   # process frontmost Chrome window
#   ./run.sh --window 2        # process second window
#   ./run.sh --dry-run         # preview without writing to Pinboard
#   ./run.sh --limit 20        # only process first 20 tabs
#   ./run.sh --dedupe          # skip duplicate URLs
#   ./run.sh --window 2 --dry-run --limit 10 --dedupe
#
# Required env (or edit the defaults below):
#   PINBOARD_TOKEN   username:token   (https://pinboard.in/settings/password)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="chrome-tabs-to-pinboard"

# ─── Help ────────────────────────────────────────────────────────────────────
show_help() {
  cat << 'EOF'
Chrome Tabs to Pinboard - Bookmark your tabs with AI-generated tags

USAGE:
  ./run.sh [OPTIONS]

OPTIONS:
  --window N         Process Chrome window N (default: 1)
  --limit N          Only process first N tabs (default: all)
  --dry-run          Preview without writing to Pinboard
  --dedupe           Skip URLs already in Pinboard (recommended)
  --no-reload        Skip reloading suspended tabs (faster)
  --close-tabs       Close tabs after successful bookmarking
  --refresh-cache    Force refresh bookmark cache (24hr TTL)
  --help             Show this help message

ENVIRONMENT:
  PINBOARD_TOKEN     Required: username:token from pinboard.in/settings/password

EXAMPLES:
  # Preview first 10 tabs
  ./run.sh --dry-run --limit 10

  # Bookmark all tabs, skip duplicates
  ./run.sh --dedupe

  # Bookmark and close all tabs (recommended)
  ./run.sh --dedupe --no-reload --close-tabs

  # Process 2nd Chrome window
  ./run.sh --window 2 --dedupe

FILTERED DOMAINS:
  Automatically skips: lamolabs.org, flomarching.com, google.com, pinboard.in
  
TWITTER/X.COM:
  Included with username extraction + generic tags (twitter, social, tweet)
  Note: Tweet content requires JavaScript, so tags are generic

CACHE:
  Bookmark cache: ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json

MORE INFO:
  https://github.com/yourusername/chrome-tabs-to-pinboard
EOF
  exit 0
}

# ─── Defaults ────────────────────────────────────────────────────────────────
WINDOW=1
DRY_RUN=""
LIMIT=0
DEDUPE=""
NO_RELOAD=""
CLOSE_TABS=""
REFRESH_CACHE=""

# ─── Arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)       show_help ;;
    --window)        WINDOW="$2"; shift 2 ;;
    --limit)         LIMIT="$2";  shift 2 ;;
    --dry-run)       DRY_RUN="1"; shift   ;;
    --dedupe)        DEDUPE="1";  shift   ;;
    --no-reload)     NO_RELOAD="1"; shift ;;
    --close-tabs)    CLOSE_TABS="1"; shift ;;
    --refresh-cache) REFRESH_CACHE="1"; shift ;;
    *) echo "Unknown option: $1"; echo "Use --help for usage information."; exit 1 ;;
  esac
done

# ─── Load .env if present ────────────────────────────────────────────────────
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a  # automatically export all variables
  source "${SCRIPT_DIR}/.env"
  set +a
fi

# ─── Pinboard token check ────────────────────────────────────────────────────
PINBOARD_TOKEN="${PINBOARD_TOKEN:-}"
if [[ -z "$DRY_RUN" && ! "$PINBOARD_TOKEN" == *:* ]]; then
  echo "ERROR: Set PINBOARD_TOKEN=username:token before running."
  echo "       (https://pinboard.in/settings/password)"
  exit 1
fi

# ─── Build image if needed ───────────────────────────────────────────────────
# Compute checksum of source files to detect changes
SRC_HASH="$(cat "${SCRIPT_DIR}/index.js" "${SCRIPT_DIR}/Dockerfile" 2>/dev/null | shasum -a 256 | awk '{print $1}')"
REBUILD=0

if ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
  REBUILD=1
else
  # Check if source hash changed
  LABEL_HASH="$(docker image inspect "$IMAGE_NAME" --format '{{index .Config.Labels "src.hash"}}' 2>/dev/null || echo "")"
  if [[ "$LABEL_HASH" != "$SRC_HASH" ]]; then
    REBUILD=1
  fi
fi

if [[ $REBUILD -eq 1 ]]; then
  echo "Building Docker image '$IMAGE_NAME' ..."
  docker build -t "$IMAGE_NAME" --label "src.hash=$SRC_HASH" "$SCRIPT_DIR"
fi

# ─── Get tabs from Chrome ─────────────────────────────────────────────────────
echo "Reading tabs from Chrome window ${WINDOW} ..."
TABS_JSON="$("${SCRIPT_DIR}/get_tabs.sh" "$WINDOW" "$NO_RELOAD")"
TAB_COUNT="$(echo "$TABS_JSON" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).length))" 2>/dev/null || echo "?")"
echo "Found ${TAB_COUNT} tab(s) in window ${WINDOW}."

# ─── Run container ───────────────────────────────────────────────────────────
SUCCESS_FILE="$(mktemp)"
CACHE_DIR="${HOME}/.cache/chrome-tabs-pinboard"
mkdir -p "$CACHE_DIR"

echo "$TABS_JSON" | docker run --rm -i \
  -e "PINBOARD_TOKEN=${PINBOARD_TOKEN}" \
  -e "DRY_RUN=${DRY_RUN:-0}" \
  -e "LIMIT=${LIMIT}" \
  -e "DEDUPE=${DEDUPE:-0}" \
  -e "DELAY_MS=${DELAY_MS:-3200}" \
  -e "CLOSE_TABS=${CLOSE_TABS:-0}" \
  -e "REFRESH_CACHE=${REFRESH_CACHE:-0}" \
  -v "${CACHE_DIR}:/cache" \
  "$IMAGE_NAME" > "$SUCCESS_FILE"

# ─── Close successfully processed tabs ──────────────────────────────────────
if [[ -n "$CLOSE_TABS" && -z "$DRY_RUN" ]]; then
  SUCCESSFUL_URLS="$(grep '^SUCCESS_URL:' "$SUCCESS_FILE" | sed 's/^SUCCESS_URL://' || true)"
  if [[ -n "$SUCCESSFUL_URLS" ]]; then
    URL_COUNT="$(echo "$SUCCESSFUL_URLS" | grep -c . || echo 0)"
    echo "Closing $URL_COUNT tab(s)..."
    "${SCRIPT_DIR}/close_tabs.sh" "$WINDOW" <<< "$SUCCESSFUL_URLS"
  fi
fi

# Show regular output (filter out SUCCESS_URL lines)
grep -v '^SUCCESS_URL:' "$SUCCESS_FILE" || true
rm -f "$SUCCESS_FILE"
