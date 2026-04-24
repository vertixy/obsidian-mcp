#!/bin/sh
set -e
MODE="${1:-stdio}"
case "$MODE" in
  stdio)
    echo "Starting Obsidian MCP Server in stdio mode..."
    exec node dist/stdio/index.js
    ;;
  http)
    echo "Starting Obsidian MCP Server in http mode..."
    exec node dist/http/index.js
    ;;
  *)
    echo "Error: Invalid mode."
    exit 1
    ;;
esac
