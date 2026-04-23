#!/usr/bin/env bash
#
# Run Claude Code against a local Ollama model.
#
# Prereqs:
#   1. Ollama installed and running:  ollama serve
#   2. Pull a tool-capable model, e.g. one of:
#        ollama pull qwen2.5-coder:7b
#        ollama pull llama3.1:8b
#        ollama pull mistral:7b
#
# Usage:
#   ./start-ollama.sh qwen2.5-coder:7b              # interactive
#   ./start-ollama.sh llama3.1:8b -p "list files"   # one-shot
#   OLLAMA_HOST=http://other-host:11434 ./start-ollama.sh qwen2.5-coder:7b
#   PROMPTED_TOOLS=1 ./start-ollama.sh phi3:mini    # for models w/o native tool calling
#
# What this does:
#   1. Starts the bundled Anthropic→Ollama proxy on $PROXY_PORT (default 11435)
#   2. Sets ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY to point at it
#   3. Launches Claude Code via the existing start.sh
#   4. Tears the proxy down on exit

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ -z "$1" ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  cat <<EOF
Usage: ./start-ollama.sh <ollama-model> [claude-code args...]

Examples:
  ./start-ollama.sh qwen2.5-coder:7b
  ./start-ollama.sh llama3.1:8b -p "summarize README"

Env:
  PROXY_PORT       proxy listen port (default 11435)
  OLLAMA_HOST      upstream Ollama URL (default http://127.0.0.1:11434)
  PROMPTED_TOOLS   set to 1 if your model lacks native tool calling
  PROXY_DEBUG      set to 1 for verbose proxy logs
EOF
  exit 0
fi

MODEL="$1"
shift

export PROXY_PORT="${PROXY_PORT:-11435}"
export OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
export OLLAMA_MODEL="$MODEL"

# Quick sanity check: is Ollama reachable?
if ! curl -fsS "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  echo "✗ Cannot reach Ollama at $OLLAMA_HOST"
  echo "  Start it with:  ollama serve"
  exit 1
fi

# Start the proxy in background, capture pid
PROXY_LOG="$(mktemp -t ollama-proxy.XXXXXX.log)"
PORT="$PROXY_PORT" OLLAMA_HOST="$OLLAMA_HOST" OLLAMA_MODEL="$OLLAMA_MODEL" \
  PROMPTED_TOOLS="${PROMPTED_TOOLS:-0}" PROXY_DEBUG="${PROXY_DEBUG:-0}" \
  node "$DIR/scripts/ollama-proxy.mjs" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!

cleanup() {
  if kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
  fi
  rm -f "$PROXY_LOG"
}
trap cleanup EXIT INT TERM

# Wait for proxy to come up (≤ 5s)
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "✗ Proxy failed to start. Log:"
    cat "$PROXY_LOG"
    exit 1
  fi
done

echo "✓ Ollama proxy ready on http://127.0.0.1:$PROXY_PORT  (model: $MODEL)"
echo

export ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT"
export ANTHROPIC_API_KEY="ollama-local"
# The auto-detect in start.sh will disable prompt caching and other Anthropic-only
# features because the base URL doesn't contain "anthropic.com".

exec "$DIR/start.sh" "$@"
