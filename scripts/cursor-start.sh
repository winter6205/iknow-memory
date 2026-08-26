#!/usr/bin/env bash
# Per-boot runtime for Cursor Cloud Agent (`start` phase).
#
# iknow-memory is a stdio MCP server — do not `npm start` here (it would
# block on stdin). Dependencies are in the snapshot from cursor-install.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n=== cursor-start: %s ===\n' "$*"; }

log "git attribution"
bash "$REPO_ROOT/scripts/cursor-git-attribution.sh"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
export PATH="$HOME/.local/bin:$PATH"

log "postgres"
# Installed and configured by cursor-install.sh (in the snapshot); the
# process does not survive snapshot/boot, so reconcile it here.
PG_VERSION=16
if ! pg_isready -h localhost -p 5432 -q; then
  sudo pg_ctlcluster "$PG_VERSION" main start
fi
pg_isready -h localhost -p 5432 -t 30

test -f "$REPO_ROOT/dist/index.js"

# --------------------------------------------------------------------
# Embedding boot defaults (Zhipu embedding-3, OpenAI-compatible)
# --------------------------------------------------------------------
# Same pattern as iknow/fin Cloud start: setdefault URL/model/dims only.
# Dedicated secret — do NOT reuse ANTHROPIC_AUTH_TOKEN (MiniMax chat).
# Official API: POST {base}/embeddings
#   https://open.bigmodel.cn/api/paas/v4/embeddings
#   model embedding-3, Bearer, dimensions 2048 (provider default).
# NineRouterEmbedder appends /embeddings onto a base that already includes
# the version segment (local 9router uses /v1; Zhipu official uses /v4).
BASHRC_EMBED_MARKER="# cursor-start: iknow-memory Zhipu embedding-3"
log "embed env defaults"
export GRAPHRAG_MEMORY_EMBED_BASE_URL="${GRAPHRAG_MEMORY_EMBED_BASE_URL:-https://open.bigmodel.cn/api/paas/v4}"
export GRAPHRAG_MEMORY_EMBED_MODEL="${GRAPHRAG_MEMORY_EMBED_MODEL:-embedding-3}"
export GRAPHRAG_MEMORY_EMBED_DIMENSIONS="${GRAPHRAG_MEMORY_EMBED_DIMENSIONS:-2048}"
if [ -n "${GRAPHRAG_MEMORY_EMBED_API_KEY:-}" ]; then
  log "GRAPHRAG_MEMORY_EMBED_API_KEY=SET"
else
  log "GRAPHRAG_MEMORY_EMBED_API_KEY=UNSET (inject Cloud Secret with this name)"
fi

if ! grep -qF "$BASHRC_EMBED_MARKER" "$HOME/.bashrc" 2>/dev/null; then
  {
    printf '%s\n' "$BASHRC_EMBED_MARKER"
    printf '%s\n' 'export GRAPHRAG_MEMORY_EMBED_BASE_URL="${GRAPHRAG_MEMORY_EMBED_BASE_URL:-https://open.bigmodel.cn/api/paas/v4}"'
    printf '%s\n' 'export GRAPHRAG_MEMORY_EMBED_MODEL="${GRAPHRAG_MEMORY_EMBED_MODEL:-embedding-3}"'
    printf '%s\n' 'export GRAPHRAG_MEMORY_EMBED_DIMENSIONS="${GRAPHRAG_MEMORY_EMBED_DIMENSIONS:-2048}"'
  } >>"$HOME/.bashrc"
fi

log "ready (MCP is on-demand: node dist/index.js)"
