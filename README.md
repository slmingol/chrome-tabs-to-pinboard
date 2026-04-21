# Chrome Tabs to Pinboard

Automatically bookmark your Chrome tabs to Pinboard with AI-generated tags and summaries.

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
  - [Using Make (Recommended)](#using-make-recommended)
  - [Using run.sh Directly](#using-runsh-directly)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Tips & Best Practices](#tips--best-practices)
- [Troubleshooting](#troubleshooting)
- [Files](#files)
- [Examples](#examples)
- [Performance](#performance)
- [FAQ](#faq)
- [License](#license)

## Overview

This tool extracts all tabs from a Chrome window, analyzes their content, generates intelligent 5-10 word summaries and relevant tags, then bookmarks them to [Pinboard.in](https://pinboard.in). Optionally closes tabs after successful bookmarking.

**Key Features:**
- 🏷️ **Smart tagging** - Filters out generic stopwords, keeps meaningful identifiers
- 📝 **Auto-summaries** - Generates concise descriptions from page content
- 🎯 **Domain-specific extractors** - Special handling for YouTube, Reddit, Medium, Twitter/X (extracts actual tweet content!)
- 💾 **Bookmark caching** - Stores your existing bookmarks (24hr TTL) to avoid repeated API calls
- 🔄 **Deduplication** - Skips URLs already in your Pinboard collection
- 🗑️ **Auto-close tabs** - Optionally closes bookmarked tabs to clean up your browser
- 🐳 **Containerized** - Runs in Docker with zero npm dependencies
- ⚡ **Suspended tab support** - Handles Chrome extension suspended tabs without reloading

## Requirements

- **macOS** (uses AppleScript to interact with Chrome)
- **Google Chrome**
- **Docker or Podman**
- **Pinboard account** with API token ([get yours here](https://pinboard.in/settings/password))
- **Node.js 22+** (inside container, automatically handled by Docker)

## Quick Start

```bash
# 1. Clone and setup
cd ~/dev/projects
git clone <repo-url> chrome-tabs-to-pinboard
cd chrome-tabs-to-pinboard
make install

# 2. Set your Pinboard token
export PINBOARD_TOKEN="username:hextoken"

# 3. Test with first 5 tabs
make test

# 4. Bookmark and close all tabs (recommended)
make close-all
```

## Installation

1. Clone or download this project:
   ```bash
   cd ~/dev/projects
   git clone <repo-url> chrome-tabs-to-pinboard
   cd chrome-tabs-to-pinboard
   ```

2. Make scripts executable:
   ```bash
   chmod +x run.sh get_tabs.sh close_tabs.sh
   # Or simply:
   make install
   ```

3. Set your Pinboard API token:
   ```bash
   export PINBOARD_TOKEN="username:hextoken"
   ```
   
   To make this permanent, add it to your `~/.zshrc` or `~/.bashrc`:
   ```bash
   echo 'export PINBOARD_TOKEN="username:hextoken"' >> ~/.zshrc
   ```

## Usage

### Using Make (Recommended)

The Makefile provides convenient shortcuts for common operations:

```bash
# Show all available commands
make help

# Preview first 10 tabs without writing
make preview LIMIT=10

# Bookmark all tabs with deduplication
make dedupe

# Fast mode: bookmark and close all tabs (recommended)
make close-all

# Quick test with first 10 tabs
make close-fast

# Process specific window
make w2  # Process window 2 with dedupe + close
```

Common Make targets:
- `make help` - Show all available commands
- `make check-token` - Verify PINBOARD_TOKEN is set
- `make install` - Make scripts executable
- `make build` - Build Docker image
- `make test` - Test with first 5 tabs (dry-run)
- `make preview` - Preview without writing to Pinboard
- `make dedupe` - Process with deduplication
- `make fast` - Fast mode (dedupe + no-reload)
- `make close` - Process and close tabs
- `make close-all` - **Recommended** (dedupe + no-reload + close)
- `make close-fast` - Quick test: close first 10 tabs
- `make refresh-cache` - Refresh bookmark cache from Pinboard
- `make clear-cache` - Delete cache (rebuilds on next run)
- `make update-cache` - Alias for refresh-cache
- `make show-cache` - Display cache information
- `make stats` - Show project statistics
- `make clean` - Remove Docker image and cache

**Short aliases:**
- `make p` → preview
- `make t` → test  
- `make r` → run
- `make d` → dedupe
- `make c` → close
- `make ca` → close-all

**Window shortcuts:**
- `make w1` - Process window 1 (dedupe + close)
- `make w2` - Process window 2 (dedupe + close)
- `make w3` - Process window 3 (dedupe + close)

### Using run.sh Directly

### Quick Help

```bash
./run.sh --help
```

### Basic Usage

Process all tabs in the frontmost Chrome window:
```bash
./run.sh --window 1
```

### Common Options

```bash
# Show help message with all options
./run.sh --help

# Preview without writing to Pinboard
./run.sh --window 1 --dry-run

# Skip tabs already in Pinboard (highly recommended)
./run.sh --window 1 --dedupe

# Process only first 10 tabs (for testing)
./run.sh --window 1 --limit 10

# Skip reloading suspended tabs (faster but may miss some)
./run.sh --window 1 --no-reload

# Close tabs after successful bookmarking
./run.sh --window 1 --dedupe --close-tabs

# Refresh bookmark cache (if your collection changed recently)
./run.sh --window 1 --refresh-cache
```

### Recommended Command

For daily use with a large tab collection:
```bash
./run.sh --window 1 --dedupe --no-reload --close-tabs
```

This will:
1. Extract tabs without reloading (fast)
2. Skip duplicates from your 47k+ bookmarks
3. Bookmark new ones
4. Close all bookmarked tabs (new + existing)

## How It Works

### Architecture

```
┌────────────┐         ┌─────────────────┐         ┌──────────────┐
│   Chrome   │ ──────> │  AppleScript    │ ──────> │   Docker     │
│  (macOS)   │  tabs   │  (get_tabs.sh)  │  JSON   │  Container   │
└────────────┘         └─────────────────┘         └──────────────┘
                                                            │
                                                            v
                                                    ┌──────────────┐
                                                    │  index.js    │
                                                    │  - Fetch page│
                                                    │  - Tokenize  │
                                                    │  - Generate  │
                                                    │    tags      │
                                                    └──────────────┘
                                                            │
                                                            v
                                                    ┌──────────────┐
                                                    │ Pinboard API │
                                                    │  posts/add   │
                                                    └──────────────┘
```

### Processing Pipeline

1. **Tab Extraction** (`get_tabs.sh`)
   - Uses AppleScript to read Chrome window tabs
   - Optionally activates and reloads suspended tabs
   - Outputs JSON: `[{"title": "...", "url": "..."}]`

2. **Content Fetching** (`index.js`)
   - HTTP GET with 10-second timeout, 600KB limit
   - Follows redirects (max 5)
   - **Domain-specific extractors:**
     - **YouTube**: oEmbed API for clean video metadata
     - **Reddit**: Post titles from URL slugs + og:title
     - **Twitter/X.com**: Embedded JSON extraction with status ID matching
     - **Medium**: Meta tags and article content
   - Decompresses gzip/brotli responses for Twitter

3. **Tag Generation**
   - Tokenizes title + URL + page content
   - Filters 150+ stopwords ("the", "and", "how", etc.)
   - Removes random alphanumeric IDs (keeps meaningful ones like "qwen36")
   - Selects top 5-8 keywords by frequency

4. **Bookmarking**
   - Checks local cache (24hr TTL) for duplicates
   - Posts to Pinboard with 3.2s rate limit
   - Marks as public (`shared=yes`)
   - Outputs success markers for tab closing

5. **Tab Closing** (`close_tabs.sh`)
   - Extracts real URLs from suspended tabs
   - Matches against success list
   - Closes tabs via AppleScript

## Configuration

### Filtered Domains

These domains are automatically skipped (edit `index.js` to customize):
- `lamolabs.org`
- `flomarching.com`
- `google.com` (main domain only - **subdomains like `cloud.google.com` are allowed**)
  - PDFs on google.com are also allowed (`.pdf` in URL)
- `pinboard.in`

### Twitter/X.com Support

Twitter/X.com tabs are **fully supported** with intelligent extraction:
- ✅ Fetches page HTML via HTTP
- ✅ Extracts tweet content from embedded JSON (`full_text` field)
- ✅ Matches specific tweet by status ID (handles quoted tweets correctly)
- ✅ Decodes HTML entities (apostrophes, quotes, etc.)
- ✅ Extracts hashtags from tweet text
- ✅ Generates specific tags from actual tweet content

**Example results:**
- AWS scaling tweet → tags: `aws object storage different level`
- FDE hiring tweet → tags: `few asked companies hire fdes`
- Periodic table tweet → tags: `moseley henry inventor modern periodic`

**Fallback:** If tweet extraction fails (rare), uses: `username twitter social tweet`

### Rate Limiting

Default: 3.2 seconds between Pinboard API calls (avoid 429 errors)

To adjust:
```bash
# Using run.sh
DELAY_MS=2000 ./run.sh --window 1

# Using Make
make dedupe DELAY_MS=2000
```

### Cache Location

Bookmark cache stored at: `~/.cache/chrome-tabs-pinboard/.pinboard_cache.json`

**Cache auto-refresh:** 24 hours

**Manual cache management:**
```bash
# View cache information
make show-cache

# Force refresh from Pinboard API
make refresh-cache
# or
make update-cache

# Delete cache (auto-rebuilds on next run)
make clear-cache

# Full cleanup (Docker image + cache)
make clean
```

## Tips & Best Practices

### Recommended Daily Workflow

1. **Safe approach** - Preview first, then commit:
   ```bash
   make preview LIMIT=10  # Check what will be added
   make close-all         # Commit and close
   ```

2. **Fast approach** - One command cleanup:
   ```bash
   make close-all  # Skip reload, dedupe, close tabs
   ```

### When to Use Each Mode

- **`make test`** - First time using the tool or testing changes
- **`make preview`** - Want to see tags/summaries before committing  
- **`make dedupe`** - Large bookmark collection (thousands), avoid duplicates
- **`make fast`** - Speed over accuracy, skip suspended tab reload
- **`make close-all`** - Daily use, quick cleanup (recommended)

### Working with Suspended Tabs

Chrome extension suspended tabs (like "The Great Suspender") are handled automatically:
- **With `--no-reload`**: Extracts real URL from suspension metadata (fast)
- **Without `--no-reload`**: Activates and reloads each tab (accurate but slow)

For large tab collections (100+), use `--no-reload` for speed.

### Cache Strategy

- **Let it auto-refresh**: 24hr TTL is usually sufficient
- **Force refresh when**: 
  - Added bookmarks from another device
  - Deleted many bookmarks from Pinboard
  - Getting unexpected "already in Pinboard" messages
- **Clear cache when**: Testing or troubleshooting

### Avoiding Rate Limits

Pinboard API allows ~1 request per 3 seconds. The tool defaults to 3.2s delays.

If you hit rate limits:
```bash
make dedupe DELAY_MS=4000  # Increase to 4 seconds
```

## Troubleshooting

### "Set PINBOARD_TOKEN" error

Your API token isn't set. Get it from: https://pinboard.in/settings/password

Format: `username:hexadecimaltoken`

### Tabs not closing

- Ensure you're using `--close-tabs` flag
- Check that URLs match exactly (script handles suspended tabs automatically)
- Verify Chrome window index is correct (`--window 1` for first window)

### "Unterminated string in JSON"

Your bookmark collection is too large. The script now handles this automatically with `Infinity` maxSize for Pinboard API calls.

### Suspended tabs showing empty titles

Use default behavior (without `--no-reload`) to activate tabs before extraction. Or use `--no-reload` with `--close-tabs` (script extracts real URLs from suspended tab fragments).

### Docker image not rebuilding

The script auto-rebuilds when `index.js` or `Dockerfile` changes. To force rebuild:
```bash
# Using make
make clean
make build

# Or manually
docker rmi chrome-tabs-to-pinboard
./run.sh --window 1
```

### Verify token is set

```bash
make check-token
```

This validates your PINBOARD_TOKEN environment variable is properly configured.

## Files

- **`Makefile`** - Build automation and convenient shortcuts
- **`run.sh`** - Main orchestrator script
- **`get_tabs.sh`** - AppleScript tab extractor
- **`close_tabs.sh`** - AppleScript tab closer
- **`index.js`** - Node.js processing logic (runs in container)
- **`Dockerfile`** - Container image definition

## Examples

### Common Workflows

```bash
# Daily cleanup: bookmark everything and close tabs
make close-all

# Safe preview before committing
make preview LIMIT=20

# Process specific Chrome window
make close-all WINDOW=2

# Test with a small batch first
make close-fast  # First 10 tabs

# Fast processing without reloading suspended tabs
make fast

# Check token is configured
make check-token

# View cache status (age, size, bookmark count)
make show-cache

# Refresh cache if you added bookmarks elsewhere
make refresh-cache
```

### Morning Tab Cleanup Routine

```bash
# 1. Check everything is ready
make check-token

# 2. Preview what will be bookmarked
make preview LIMIT=10

# 3. Bookmark and close all tabs
make close-all

# 4. If needed, refresh cache for other windows
make refresh-cache
```

### Processing Multiple Windows

```bash
# Process each window separately
make w1   # Window 1
make w2   # Window 2  
make w3   # Window 3

# Or with custom options
make close-all WINDOW=1
make close-all WINDOW=2
```

### Using Make

```bash
# Preview first 5 tabs (dry-run)
make test

# Bookmark 100 tabs with deduplication
make dedupe LIMIT=100

# Process window 2 with close-all
make close-all WINDOW=2

# Quick test - close first 10 tabs
make close-fast

# Cache management
make show-cache      # Display cache info
make refresh-cache   # Force refresh from Pinboard
make clear-cache     # Delete cache file

# Project statistics
make stats

# Window shortcuts
make w2              # Process window 2

# Using variables
make preview LIMIT=20 WINDOW=2
make dedupe LIMIT=50
make close-all WINDOW=3
```

### Using run.sh

### Dry run to preview tags

```bash
./run.sh --window 1 --dry-run --limit 5
```

Output:
```
[1/5] Example Page Title
  URL:     https://example.com/article
  SUMMARY: example domain documentation demos without needing permission
  TAGS:    example domain documentation demos permission
```

### Process 100 tabs with deduplication

```bash
./run.sh --window 1 --dedupe --limit 100
```

### Full cleanup - bookmark and close everything

```bash
./run.sh --window 1 --dedupe --close-tabs
```

## Performance

- **Fast mode** (`--no-reload`): ~0.5s per tab extraction
- **Full mode** (default): ~3.5s per tab (activates suspended tabs)
- **Bookmarking**: 3.2s per new bookmark (Pinboard API rate limit)
- **Cache**: Saves ~60s on subsequent runs (24hr TTL)

Example: 50 tabs (30 new, 20 duplicates) = ~2 minutes total

**Project Statistics:**
```bash
make stats
```

Output:
```
Project Statistics:
  Scripts: 4
  Total lines: 1006
  Node.js lines: 655
  Shell lines: 342
```

## FAQ

**Q: Will this close tabs that fail to bookmark?**  
A: No, only successfully bookmarked tabs are closed (marked with ✓).

**Q: Can I customize which domains are filtered?**  
A: Yes, edit the `SKIP_DOMAINS` list in `index.js` (around line 40).

**Q: How do I bookmark private/unlisted URLs?**  
A: Currently all bookmarks are public (`shared=yes`). Edit `pinboardAdd()` in `index.js` to change this.

**Q: Does this work with Firefox or Safari?**  
A: No, it uses AppleScript specific to Chrome. Could be adapted for other browsers.

**Q: What happens if my internet disconnects mid-run?**  
A: Failed bookmarks are marked with ✗ and tabs remain open. Re-run when connected.

**Q: Can I run this on Linux or Windows?**  
A: No, AppleScript requires macOS. You'd need to rewrite tab extraction for other platforms.

**Q: How accurate are the generated tags?**  
A: Very good for technical content, decent for general web pages. Filters 150+ stopwords and generic terms.

**Q: Can I add custom tags to generated ones?**  
A: Not currently. Edit `pinboardAdd()` in `index.js` to append custom tags.

**Q: What if I have 1000+ tabs?**  
A: Use `make fast` (skips reload) and run in batches with `LIMIT=100`. Expect ~5-10 minutes per 100 tabs.

**Q: Why are some tabs showing as "already in Pinboard" when they're not?**  
A: Your cache may be stale. Run `make refresh-cache` to update from Pinboard API.

**Q: Can I run this automatically on a schedule?**  
A: Yes, create a cron job or launchd task. Ensure PINBOARD_TOKEN is set in the environment.

## License

MIT

## Credits

Built with zero npm dependencies using Node.js built-ins:
- `https` / `http` - HTTP client
- `url` - URL parsing
- `fs` - File system (cache)
- `path` - Path utilities

Containerized with Docker (node:22-alpine base image).
