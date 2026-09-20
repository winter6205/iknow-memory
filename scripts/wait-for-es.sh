#!/usr/bin/env bash
# CI gate: wait until Elasticsearch answers on the HOST's published path.
#
# Why this exists (first red run of the `test-es` job, 2026-09-14):
# `docker compose up --wait` returning "healthy" only proves the container's
# own loopback healthcheck passed. It does NOT prove the published port is
# usable from the runner — the gate failed with `curl: (56) Recv failure:
# Connection reset by peer` from the host while the container was already
# "Up (healthy)". The fix is to poll with a deadline instead of betting on
# one attempt; `curl --retry-connrefused` alone does not cover the reset.
#
# Why bash and not a Node script (2026-09-20): the TypeScript predecessor
# (scripts/wait-for-es.ts) intermittently died with bare `exit 13` and zero
# output ~1.4s in on the runners' Node 20.20.2 — reproducible only there, so
# the gate itself must not depend on the client whose startup it guards. The
# live suite still exercises the real client; a green gate plus red suite
# localizes the failure to the suite, not to reachability.
#
# Usage:
#   ES_URL=http://127.0.0.1:9200 bash scripts/wait-for-es.sh
#
# Exit 0 once ES answers; exit 1 after ES_WAIT_TIMEOUT_S (default 120s),
# printing one verbose curl so the workflow log carries its own cause.
set -uo pipefail

base="${ES_URL:-http://127.0.0.1:9200}"
url="${base%/}/_cluster/health"
deadline_s="${ES_WAIT_TIMEOUT_S:-120}"

attempt=0
end=$((SECONDS + deadline_s))
while (( SECONDS < end )); do
  attempt=$((attempt + 1))
  if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
    echo "wait-for-es: ${url} answered after ${attempt} attempt(s)"
    exit 0
  fi
  sleep 1
done

echo "wait-for-es: ${url} unreachable after ${attempt} attempt(s) in ${deadline_s}s" >&2
curl -v --max-time 5 "$url" >&2 || true
exit 1
