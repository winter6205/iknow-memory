#!/usr/bin/env bash
# Baseline setup for the Cursor Cloud Agent environment (`install` phase).
#
# With environment builds this runs once, while the snapshot is created.
# Idempotent. Durable files only — no long-running MCP server here
# (stdio MCP is started by the host, not as a boot daemon).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n=== cursor-install: %s ===\n' "$*"; }

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

BASHRC_MARKER='# cursor-install: ~/.local/bin'
if ! grep -qF "$BASHRC_MARKER" "$HOME/.bashrc" 2>/dev/null; then
  {
    printf '%s\n' "$BASHRC_MARKER"
    printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
  } >>"$HOME/.bashrc"
fi

log "toolchain preflight"
command -v node
node --version
command -v npm
npm --version

log "postgres + pgvector (integration tests expect postgresql://postgres@localhost:5432/postgres)"
# Ubuntu 24.04 base image → PostgreSQL 16. Durable state only: packages,
# cluster data dir, and pg_hba trust config land in the snapshot; the
# server process itself is started per-boot by cursor-start.sh.
PG_VERSION=16
if ! dpkg -s "postgresql-${PG_VERSION}-pgvector" >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    postgresql "postgresql-${PG_VERSION}-pgvector"
fi
PG_HBA="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"
if ! sudo grep -qF '# cursor-cloud trust' "$PG_HBA"; then
  sudo sed -i '1i # cursor-cloud trust (local dev/test only)\nlocal all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust' "$PG_HBA"
fi

log "npm ci + build"
# husky `prepare` is for local git hooks; Cloud snapshot has no need for it
# and it fails when hook install is skipped or .git is incomplete.
HUSKY=0 npm ci
HUSKY=0 npm run build
test -f "$REPO_ROOT/dist/index.js"

log "done"
