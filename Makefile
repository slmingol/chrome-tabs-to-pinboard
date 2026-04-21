.PHONY: help build clean test preview run dedupe close-all refresh-cache install check-token

# Default target
.DEFAULT_GOAL := help

# Configuration
WINDOW ?= 1
LIMIT ?= 0
DELAY_MS ?= 3200

# Colors for output
CYAN := \033[0;36m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
RESET := \033[0m

help: ## Show this help message
	@echo "$(CYAN)Chrome Tabs to Pinboard$(RESET)"
	@echo ""
	@echo "$(GREEN)Usage:$(RESET)"
	@echo "  make [target] [WINDOW=N] [LIMIT=N]"
	@echo ""
	@echo "$(GREEN)Targets:$(RESET)"
	@awk 'BEGIN {FS = ":.*##"; printf ""} /^[a-zA-Z_-]+:.*?##/ { printf "  $(CYAN)%-15s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "$(GREEN)Variables:$(RESET)"
	@echo "  $(CYAN)WINDOW$(RESET)     Chrome window index (default: 1)"
	@echo "  $(CYAN)LIMIT$(RESET)      Max tabs to process (default: all)"
	@echo "  $(CYAN)DELAY_MS$(RESET)   Delay between API calls (default: 3200)"
	@echo ""
	@echo "$(GREEN)Examples:$(RESET)"
	@echo "  make preview LIMIT=10       # Preview first 10 tabs"
	@echo "  make dedupe WINDOW=2        # Process window 2 with deduplication"
	@echo "  make close-all              # Bookmark and close all tabs"
	@echo ""

check-token: ## Check if PINBOARD_TOKEN is set
	@if [ -z "$$PINBOARD_TOKEN" ]; then \
		echo "$(RED)ERROR: PINBOARD_TOKEN not set$(RESET)"; \
		echo "$(YELLOW)Get your token from: https://pinboard.in/settings/password$(RESET)"; \
		echo "$(YELLOW)Then run: export PINBOARD_TOKEN='username:token'$(RESET)"; \
		exit 1; \
	else \
		echo "$(GREEN)✓ PINBOARD_TOKEN is set$(RESET)"; \
	fi

build: ## Build Docker image
	@echo "$(CYAN)Building Docker image...$(RESET)"
	@./run.sh --help > /dev/null 2>&1 || true
	@echo "$(GREEN)✓ Image ready$(RESET)"

clean: ## Remove Docker image and cache
	@echo "$(CYAN)Cleaning up...$(RESET)"
	@docker rmi chrome-tabs-to-pinboard 2>/dev/null || true
	@rm -f ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json
	@rm -f test_*.sh debug_*.sh *.log 2>/dev/null || true
	@echo "$(GREEN)✓ Clean complete$(RESET)"

install: ## Make scripts executable
	@echo "$(CYAN)Making scripts executable...$(RESET)"
	@chmod +x run.sh get_tabs.sh close_tabs.sh
	@echo "$(GREEN)✓ Installation complete$(RESET)"

preview: check-token ## Dry-run preview (no writes to Pinboard)
	@echo "$(CYAN)Previewing tabs (dry-run mode)...$(RESET)"
	@./run.sh --window $(WINDOW) --dry-run $(if $(filter-out 0,$(LIMIT)),--limit $(LIMIT))

test: check-token ## Test with first 5 tabs (dry-run)
	@echo "$(CYAN)Testing with first 5 tabs...$(RESET)"
	@./run.sh --window $(WINDOW) --dry-run --limit 5

run: check-token ## Process tabs (basic mode)
	@echo "$(CYAN)Processing tabs in window $(WINDOW)...$(RESET)"
	@./run.sh --window $(WINDOW) $(if $(filter-out 0,$(LIMIT)),--limit $(LIMIT))

dedupe: check-token ## Process tabs with deduplication
	@echo "$(CYAN)Processing tabs with deduplication...$(RESET)"
	@./run.sh --window $(WINDOW) --dedupe $(if $(filter-out 0,$(LIMIT)),--limit $(LIMIT))

fast: check-token ## Fast mode: dedupe + no-reload
	@echo "$(CYAN)Fast processing (no reload)...$(RESET)"
	@./run.sh --window $(WINDOW) --dedupe --no-reload $(if $(filter-out 0,$(LIMIT)),--limit $(LIMIT))

close: check-token ## Process and close tabs
	@echo "$(CYAN)Processing and closing tabs...$(RESET)"
	@./run.sh --window $(WINDOW) --dedupe --close-tabs $(if $(filter-out 0,$(LIMIT)),--limit $(LIMIT))

close-all: check-token ## Recommended: dedupe + no-reload + close tabs
	@echo "$(CYAN)Processing all tabs (dedupe, no-reload, close)...$(RESET)"
	@./run.sh --window $(WINDOW) --dedupe --no-reload --close-tabs

close-fast: check-token ## Quick test: close first 10 tabs
	@echo "$(CYAN)Quick test: closing first 10 tabs...$(RESET)"
	@./run.sh --window $(WINDOW) --dedupe --no-reload --close-tabs --limit 10

refresh-cache: ## Force refresh bookmark cache
	@echo "$(CYAN)Refreshing bookmark cache...$(RESET)"
	@./run.sh --window $(WINDOW) --refresh-cache --dry-run --limit 1

clear-cache: ## Delete cache file (will rebuild on next run)
	@echo "$(CYAN)Clearing bookmark cache...$(RESET)"
	@rm -f ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json
	@echo "$(GREEN)✓ Cache cleared (will rebuild on next run)$(RESET)"

update-cache: refresh-cache ## Alias for refresh-cache

show-cache: ## Show cache info
	@echo "$(CYAN)Cache information:$(RESET)"
	@if [ -f ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json ]; then \
		echo "  Location: ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json"; \
		echo "  Size: $$(du -h ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json | cut -f1)"; \
		echo "  Modified: $$(stat -f '%Sm' ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json)"; \
		echo "  Bookmarks: $$(jq 'length' ~/.cache/chrome-tabs-pinboard/.pinboard_cache.json 2>/dev/null || echo 'N/A')"; \
	else \
		echo "  $(YELLOW)No cache file found$(RESET)"; \
	fi

stats: ## Show project statistics
	@echo "$(CYAN)Project Statistics:$(RESET)"
	@echo "  Scripts: $$(ls -1 *.sh | wc -l | tr -d ' ')"
	@echo "  Total lines: $$(cat *.sh *.js Dockerfile 2>/dev/null | wc -l | tr -d ' ')"
	@echo "  Node.js lines: $$(cat index.js 2>/dev/null | wc -l | tr -d ' ')"
	@echo "  Shell lines: $$(cat *.sh 2>/dev/null | wc -l | tr -d ' ')"

# Quick aliases
p: preview ## Alias for preview
t: test ## Alias for test
r: run ## Alias for run
d: dedupe ## Alias for dedupe
c: close ## Alias for close
ca: close-all ## Alias for close-all

# Window-specific shortcuts
w1: ## Process window 1 (dedupe + close)
	@$(MAKE) close-all WINDOW=1

w2: ## Process window 2 (dedupe + close)
	@$(MAKE) close-all WINDOW=2

w3: ## Process window 3 (dedupe + close)
	@$(MAKE) close-all WINDOW=3
