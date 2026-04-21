#!/usr/bin/env bash
# Closes tabs in Chrome that match URLs from stdin.
# Usage: echo -e "url1\nurl2\nurl3" | ./close_tabs.sh [window_index]

set -euo pipefail

WINDOW="${1:-1}"

# Read URLs from stdin into an array, stripping whitespace
mapfile -t URLS_RAW
URLS=()
for url in "${URLS_RAW[@]}"; do
  # Trim leading/trailing whitespace and add to clean array
  clean_url="$(echo "$url" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ -n "$clean_url" ]]; then
    URLS+=("$clean_url")
  fi
done

if [[ ${#URLS[@]} -eq 0 ]]; then
  echo >&2 "No URLs to close."
  exit 0
fi

echo >&2 "Closing ${#URLS[@]} tab(s) in window ${WINDOW}..."

# Build AppleScript array of URLs
URL_ARRAY=""
for url in "${URLS[@]}"; do
  # Escape quotes in URL for AppleScript
  escaped="${url//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  if [[ -n "$URL_ARRAY" ]]; then
    URL_ARRAY="${URL_ARRAY}, "
  fi
  URL_ARRAY="${URL_ARRAY}\"${escaped}\""
done

result=$(osascript <<APPLESCRIPT
tell application "Google Chrome"
  if (count of windows) < $WINDOW then
    error "Window index $WINDOW out of range"
  end if
  
  set w to window $WINDOW
  set urlsToClose to {$URL_ARRAY}
  set tabList to tabs of w
  
  set closedCount to 0
  
  -- Close tabs in reverse order to avoid index shifting
  repeat with i from (count of tabList) to 1 by -1
    set t to item i of tabList
    set tabURL to URL of t
    
    -- For suspended tabs, extract the real URL from the chrome-extension fragment
    set realURL to tabURL
    if tabURL starts with "chrome-extension://" and tabURL contains "suspended.html#" then
      try
        set uriPos to offset of "&uri=" in tabURL
        if uriPos > 0 then
          set realURL to text (uriPos + 5) thru -1 of tabURL
          -- URL decode the extracted URL
          set realURL to do shell script "python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' " & quoted form of realURL
        end if
      end try
    end if
    
    repeat with targetURL in urlsToClose
      -- Cast to text for proper string comparison
      set targetStr to targetURL as text
      
      -- Match against either the real URL (for suspended) or the tab URL
      if realURL is equal to targetStr or tabURL is equal to targetStr then
        close t
        set closedCount to closedCount + 1
        exit repeat
      end if
    end repeat
  end repeat
  
  return "Closed " & closedCount & " tab(s)"
end tell
APPLESCRIPT
)

echo >&2 "$result"

