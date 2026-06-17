#!/usr/bin/env bash
# backup.sh – Export all Pinboard bookmarks to a timestamped JSON file.
#
# Usage:
#   ./backup.sh [--output-dir DIR]
#
# Required env:
#   PINBOARD_TOKEN   username:token   (https://pinboard.in/settings/password)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Colors ──────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

# ─── Defaults ─────────────────────────────────────────────────────────────────
OUTPUT_DIR="${SCRIPT_DIR}/backups"

# ─── Args ─────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: ./backup.sh [--output-dir DIR]"
      echo ""
      echo "Exports all Pinboard bookmarks to a timestamped JSON file."
      echo "Default output directory: ./backups/ (inside project dir)"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── Load .env if present ─────────────────────────────────────────────────────
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

# ─── Token check ──────────────────────────────────────────────────────────────
PINBOARD_TOKEN="${PINBOARD_TOKEN:-}"
if [[ ! "$PINBOARD_TOKEN" == *:* ]]; then
  echo -e "${RED}ERROR: Set PINBOARD_TOKEN=username:token before running.${RESET}"
  echo -e "${YELLOW}       (https://pinboard.in/settings/password)${RESET}"
  exit 1
fi

# ─── Backup ───────────────────────────────────────────────────────────────────
YEAR="$(date +%Y)"
MONTH="$(date +%m)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${OUTPUT_DIR}/${YEAR}/${MONTH}"
mkdir -p "$BACKUP_DIR"
OUT_FILE="${BACKUP_DIR}/pinboard_${TIMESTAMP}.json"

echo -e "${CYAN}Fetching all bookmarks from Pinboard...${RESET}"
echo -e "${YELLOW}(This may take 30-60s for large collections)${RESET}"

HTTP_CODE="$(curl -s -w "%{http_code}" \
  -o "$OUT_FILE" \
  "https://api.pinboard.in/v1/posts/all?auth_token=${PINBOARD_TOKEN}&format=json")"

if [[ "$HTTP_CODE" != "200" ]]; then
  rm -f "$OUT_FILE"
  echo -e "${RED}ERROR: Pinboard API returned HTTP ${HTTP_CODE}${RESET}"
  if [[ "$HTTP_CODE" == "401" ]]; then
    echo -e "${YELLOW}Check your PINBOARD_TOKEN is correct.${RESET}"
  elif [[ "$HTTP_CODE" == "429" ]]; then
    echo -e "${YELLOW}Rate limited. Wait a few seconds and try again.${RESET}"
  fi
  exit 1
fi

# Validate JSON and count
COUNT="$(node -e "
  const fs = require('fs');
  try {
    const data = JSON.parse(fs.readFileSync('${OUT_FILE}', 'utf8'));
    console.log(Array.isArray(data) ? data.length : '?');
  } catch(e) {
    console.log('?');
  }
" 2>/dev/null || echo "?")"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"

echo -e "${GREEN}✓ Backup complete${RESET}"
echo -e "  Bookmarks: ${CYAN}${COUNT}${RESET}"
echo -e "  Size:      ${CYAN}${SIZE}${RESET}"
echo -e "  File:      ${CYAN}${OUT_FILE}${RESET}"
