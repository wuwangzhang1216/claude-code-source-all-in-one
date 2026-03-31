#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# First run - setup
if [ ! -d "node_modules" ]; then
  echo "[start] First run detected, running setup..."
  node scripts/setup.mjs
fi

# Ensure bun is in PATH
export PATH="$HOME/.bun/bin:$PATH"

# Check API key
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo ""
  echo "  ⚠ ANTHROPIC_API_KEY is not set."
  echo "  export ANTHROPIC_API_KEY=\"sk-ant-xxx\""
  echo ""
  exit 1
fi

# If using a non-Anthropic proxy, disable incompatible features
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  case "$ANTHROPIC_BASE_URL" in
    *api.anthropic.com*) ;;
    *)
      export DISABLE_PROMPT_CACHING="${DISABLE_PROMPT_CACHING:-1}"
      export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"
      ;;
  esac
fi

exec bun entrypoints/cli.tsx "$@"
