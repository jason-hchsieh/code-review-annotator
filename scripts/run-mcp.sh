#!/bin/bash
# Bootstrap script for code-review-annotator MCP server.
# Installs npm dependencies to ${CLAUDE_PLUGIN_DATA} on first run (or when
# package.json changes), then launches the MCP server via tsx.
set -e

ROOT="$CLAUDE_PLUGIN_ROOT"
DATA="$CLAUDE_PLUGIN_DATA"

# Install / reinstall when package.json has changed
if ! diff -q "$ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  cp "$ROOT/package.json" "$DATA/package.json"
  # Use package-lock if available for reproducible installs
  if [ -f "$ROOT/package-lock.json" ]; then
    cp "$ROOT/package-lock.json" "$DATA/package-lock.json"
    (cd "$DATA" && npm ci --prefer-offline --no-audit --no-fund --silent 2>/dev/null) \
      || (cd "$DATA" && npm install --no-audit --no-fund --silent 2>/dev/null)
  else
    (cd "$DATA" && npm install --no-audit --no-fund --silent 2>/dev/null)
  fi
fi

exec "$DATA/node_modules/.bin/tsx" "$ROOT/src/cli.ts" --mcp "$@"
