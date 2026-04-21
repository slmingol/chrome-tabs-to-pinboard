#!/usr/bin/env bash
# Runs on the HOST (macOS). Reads one Chrome window's tabs via AppleScript
# and writes a JSON array of {title, url} objects to stdout.
# Activates each tab and reloads it to wake suspended ones (from tab suspender extensions).
# Usage: ./get_tabs.sh [window_index] [no_reload]   (default: 1 = frontmost window)

set -euo pipefail

WINDOW="${1:-1}"
NO_RELOAD="${2:-}"

if [[ -z "$NO_RELOAD" ]]; then
  # Activate and reload each tab to wake suspended ones
  echo >&2 "Activating and reloading all tabs in window ${WINDOW} to wake suspended tabs..."
  osascript <<ACTIVATE
tell application "Google Chrome"
  if (count of windows) < $WINDOW then
    error "Window index $WINDOW out of range"
  end if
  set w to window $WINDOW
  set tabList to tabs of w
  set tabCount to count of tabList
  repeat with i from 1 to tabCount
    set active tab index of w to i
    delay 0.1
    tell (active tab of w) to reload
    delay 0.4
  end repeat
end tell
ACTIVATE
  # Wait for pages to finish loading and set their titles
  echo >&2 "Waiting for pages to load (including X.com JavaScript)..."
  sleep 5
else
  echo >&2 "Skipping tab reload (--no-reload specified)."
fi

echo >&2 "Extracting URLs..."

osascript <<APPLESCRIPT
tell application "Google Chrome"
  if (count of windows) < $WINDOW then
    error "Window index $WINDOW out of range"
  end if
  set w to window $WINDOW
  set out to "["
  set tabList to tabs of w
  set tabCount to count of tabList
  set addedCount to 0
  repeat with i from 1 to tabCount
    try
      set t to item i of tabList
      set tabTitle to title of t
      set tabURL to URL of t
      
      
      -- Basic JSON escaping for title and tweet content
      set tabTitle to my replaceText(tabTitle, "\\\\", "\\\\\\\\")
      set tabTitle to my replaceText(tabTitle, "\"", "\\\\\"")
      set tabTitle to my replaceText(tabTitle, (ASCII character 10), " ")
      set tabTitle to my replaceText(tabTitle, (ASCII character 13), " ")
      
      if addedCount > 0 then
        set out to out & ","
      end if
      set out to out & "{\"title\":\"" & tabTitle & "\",\"url\":\"" & tabURL & "\"}"
      set addedCount to addedCount + 1
    on error errMsg
      -- Tab may have closed during reload, skip it
    end try
  end repeat
  set out to out & "]"
  return out
end tell

on replaceText(theText, searchStr, replaceStr)
  set AppleScript's text item delimiters to searchStr
  set parts to text items of theText
  set AppleScript's text item delimiters to replaceStr
  set result to parts as string
  set AppleScript's text item delimiters to ""
  return result
end replaceText
APPLESCRIPT
