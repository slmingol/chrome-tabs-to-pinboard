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

echo -e "${CYAN}Fetching all bookmarks from Pinboard...${RESET}"
echo -e "${YELLOW}(This may take 30-60s for large collections)${RESET}"

fetch_export() {
  local fmt="$1"
  local ext="$2"
  local out="${BACKUP_DIR}/pinboard_${TIMESTAMP}.${ext}"

  local http_code
  http_code="$(curl -s -w "%{http_code}" \
    -o "$out" \
    "https://api.pinboard.in/v1/posts/all?auth_token=${PINBOARD_TOKEN}&format=${fmt}")"

  if [[ "$http_code" != "200" ]]; then
    rm -f "$out"
    echo -e "${RED}ERROR: Pinboard API returned HTTP ${http_code} for format=${fmt}${RESET}"
    if [[ "$http_code" == "401" ]]; then
      echo -e "${YELLOW}Check your PINBOARD_TOKEN is correct.${RESET}"
    elif [[ "$http_code" == "429" ]]; then
      echo -e "${YELLOW}Rate limited. Wait a few seconds and try again.${RESET}"
    fi
    return 1
  fi

  local size
  size="$(du -h "$out" | cut -f1)"
  echo -e "  ${GREEN}✓${RESET} ${fmt^^}: ${CYAN}${out}${RESET} ${YELLOW}(${size})${RESET}"
}

fetch_export json json
sleep 4
fetch_export xml xml
sleep 4
fetch_export html html

# Count bookmarks from JSON file
JSON_FILE="${BACKUP_DIR}/pinboard_${TIMESTAMP}.json"
COUNT="$(node -e "
  const fs = require('fs');
  try {
    const data = JSON.parse(fs.readFileSync('${JSON_FILE}', 'utf8'));
    console.log(Array.isArray(data) ? data.length : '?');
  } catch(e) { console.log('?'); }
" 2>/dev/null || echo "?")"

echo -e "\n${GREEN}Backup complete.${RESET} ${CYAN}${COUNT}${RESET} bookmarks."
