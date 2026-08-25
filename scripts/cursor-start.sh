#!/usr/bin/env bash
# Per-boot runtime for Cursor Cloud Agent (`start` phase).
#
# iknow-memory is a stdio MCP server — do not `npm start` here (it would
# block on stdin). Dependencies are in the snapshot from cursor-install.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n=== cursor-start: %s ===\n' "$*"; }

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
log "ready (MCP is on-demand: node dist/index.js)"
