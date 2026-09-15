#!/usr/bin/env bash
# Local Neo4j + GDS sidecar (also used by Cloud Agent install/start).
#
# Common case when Docker is available: repo-root `docker compose up`
# (docs/runbooks/local-infra.md). This script is the no-Docker path —
# tarball + GDS jar under $HOME, used by cursor-install.sh / cursor-start.sh
# and any machine that should not run the compose Neo4j. Do not bind this
# listener and compose to :7687 at the same time.
#
# The graph arm (specs/neo4j-graph-arm.md T4) needs a Neo4j that can run
# `gds.pageRank.stream`. Both are unpacked under $HOME, outside the repo,
# so nothing here can reach git.
#
# Auth is disabled rather than given a password: the listener is bound to
# 127.0.0.1 and a committed password would be a secret in a tracked file.
# That is why the exported config below sets only *_NEO4J_URI — USER and
# PASSWORD are optional in config.ts and must be set together.
#
# Version pin: GDS 2.13.x is the release that supports Neo4j 5.26 (the LTS).
# https://neo4j.com/docs/graph-data-science/current/installation/supported-neo4j-versions/
#
# Usage:
#   bash scripts/neo4j.sh install   # download + configure (idempotent)
#   bash scripts/neo4j.sh start     # start + wait for bolt
#   bash scripts/neo4j.sh stop
#   bash scripts/neo4j.sh status
#   eval "$(bash scripts/neo4j.sh env)"   # export the URI
set -euo pipefail

NEO4J_VERSION="${NEO4J_VERSION:-5.26.0}"
GDS_VERSION="${GDS_VERSION:-2.13.2}"
NEO4J_ROOT="${NEO4J_ROOT:-$HOME/.local/neo4j}"
NEO4J_HOME="$NEO4J_ROOT/neo4j-community-$NEO4J_VERSION"
BOLT_PORT="${NEO4J_BOLT_PORT:-7687}"
BOLT_URI="bolt://127.0.0.1:$BOLT_PORT"

log() { printf '\n=== neo4j: %s ===\n' "$*"; }

install_neo4j() {
  if [ -x "$NEO4J_HOME/bin/neo4j" ] &&
    [ -f "$NEO4J_HOME/plugins/neo4j-graph-data-science-$GDS_VERSION.jar" ]; then
    log "already installed at $NEO4J_HOME"
    return 0
  fi

  command -v java >/dev/null || {
    echo "neo4j.sh: java is required (Neo4j $NEO4J_VERSION needs JDK 17 or 21)" >&2
    return 1
  }

  mkdir -p "$NEO4J_ROOT"
  local tarball="$NEO4J_ROOT/neo4j-community-$NEO4J_VERSION-unix.tar.gz"
  local gdszip="$NEO4J_ROOT/gds-$GDS_VERSION.zip"

  log "download neo4j $NEO4J_VERSION"
  [ -s "$tarball" ] ||
    curl -fsSL -o "$tarball" \
      "https://dist.neo4j.org/neo4j-community-$NEO4J_VERSION-unix.tar.gz"
  [ -x "$NEO4J_HOME/bin/neo4j" ] || tar xzf "$tarball" -C "$NEO4J_ROOT"

  log "download gds $GDS_VERSION"
  [ -s "$gdszip" ] ||
    curl -fsSL -o "$gdszip" \
      "https://graphdatascience.ninja/neo4j-graph-data-science-$GDS_VERSION.zip"
  unzip -q -o -j "$gdszip" "*.jar" -d "$NEO4J_HOME/plugins"

  configure_neo4j
  log "installed at $NEO4J_HOME"
}

# Appended once, after the shipped defaults, so these win on a re-read. Keys
# the shipped neo4j.conf already declares are set with `set_conf` instead:
# Neo4j refuses to boot on a duplicated key.
configure_neo4j() {
  local conf="$NEO4J_HOME/conf/neo4j.conf"
  # Keep this string: existing installs already have it in neo4j.conf.
  # Changing it would append a second listen/auth block and refuse boot.
  local marker="# cursor-neo4j: local GDS sidecar"

  set_conf "$conf" server.http.enabled false
  set_conf "$conf" server.bolt.enabled true

  if ! grep -qF "$marker" "$conf"; then
    {
      printf '\n%s\n' "$marker"
      printf '%s\n' "server.default_listen_address=127.0.0.1"
      printf '%s\n' "server.bolt.listen_address=127.0.0.1:$BOLT_PORT"
      printf '%s\n' "dbms.security.auth_enabled=false"
      printf '%s\n' "dbms.security.procedures.unrestricted=gds.*"
      printf '%s\n' "dbms.security.procedures.allowlist=gds.*"
      printf '%s\n' "server.memory.heap.initial_size=1G"
      printf '%s\n' "server.memory.heap.max_size=2G"
      printf '%s\n' "server.memory.pagecache.size=512m"
    } >>"$conf"
  fi
}

set_conf() {
  local conf="$1" key="$2" value="$3"
  if grep -qE "^#?$key=" "$conf"; then
    sed -i "s|^#\?$key=.*|$key=$value|" "$conf"
  else
    printf '%s=%s\n' "$key" "$value" >>"$conf"
  fi
}

bolt_up() {
  (exec 3<>"/dev/tcp/127.0.0.1/$BOLT_PORT") 2>/dev/null
}

start_neo4j() {
  if bolt_up; then
    log "already listening on $BOLT_URI"
    return 0
  fi
  [ -x "$NEO4J_HOME/bin/neo4j" ] || {
    echo "neo4j.sh: not installed — run 'neo4j.sh install' first" >&2
    return 1
  }
  log "start"
  "$NEO4J_HOME/bin/neo4j" start >/dev/null

  for _ in $(seq 1 60); do
    if bolt_up; then
      log "bolt ready at $BOLT_URI"
      return 0
    fi
    sleep 2
  done
  echo "neo4j.sh: bolt did not come up within 120s" >&2
  tail -40 "$NEO4J_HOME/logs/neo4j.log" >&2 || true
  return 1
}

case "${1:-}" in
install) install_neo4j ;;
start) start_neo4j ;;
stop) "$NEO4J_HOME/bin/neo4j" stop ;;
status)
  if bolt_up; then echo "up $BOLT_URI"; else
    echo "down $BOLT_URI"
    exit 1
  fi
  ;;
env) printf 'export GRAPHRAG_MEMORY_NEO4J_URI=%s\n' "$BOLT_URI" ;;
*)
  echo "usage: neo4j.sh install|start|stop|status|env" >&2
  exit 2
  ;;
esac
