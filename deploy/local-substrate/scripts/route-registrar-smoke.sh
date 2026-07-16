#!/usr/bin/env bash
# Verifies the Phase-3 route-registrar wiring is intact:
#
#   1. The route-registrar container is running.
#   2. Its tick loop is producing 'synced N dynamic' log lines (proves Caddy
#      admin PATCH is succeeding).
#   3. Caddy admin srv0/routes is reachable and returns the expected count
#      of static routes (proves the partition strategy isn't accidentally
#      dropping Caddyfile-owned routes).
#
# Note: Takosumi v1's public deploy control API does not expose raw desired routes.
# Dynamic <id>.app.takosumi.test projection is deferred until an operator-
# internal route source lands; this smoke is the registrar wiring guard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/compose-helpers.sh"

PROFILE="$(local_substrate_profile)"
case "$PROFILE" in
	workers) REGISTRAR_CONTAINER="local-substrate-route-registrar-workers-1" ;;
	postgres) REGISTRAR_CONTAINER="local-substrate-route-registrar-1" ;;
esac

# 1. Container running
state=$(docker inspect -f '{{.State.Status}}' "$REGISTRAR_CONTAINER" 2>/dev/null || echo "missing")
if [[ "$state" != "running" ]]; then
	echo "FAIL: route-registrar container is not running (state=$state)" >&2
	exit 1
fi

# 2. Recent tick log
if ! docker logs --since 30s "$REGISTRAR_CONTAINER" 2>&1 \
		| grep -q "synced .* dynamic route"; then
	echo "FAIL: no 'synced N dynamic' log line in the last 30s" >&2
	docker logs --tail 5 "$REGISTRAR_CONTAINER" >&2
	exit 1
fi

# 3. Caddy admin reachable + static routes preserved.
# Static routes are owned by the Caddyfile; the registrar must never drop
# them. We count routes with at least one host whose suffix is NOT
# '.app.takosumi.test' as dynamic app routes.
# The Caddy admin API is intentionally NOT exposed to the host (δ23). Probe it
# from a one-shot container on the internal network; AppArmor-constrained hosts
# cannot reliably use docker exec.
STATIC_COUNT=$(local_substrate_docker_run --rm --network local-substrate_takos-local-internal \
	curlimages/curl:8.10.1 \
	-sS http://caddy:2019/config/apps/http/servers/srv0/routes 2>/dev/null \
	| python3 -c '
import json, sys
routes = json.load(sys.stdin) or []
def hosts(r): return sum((m.get("host") or [] for m in (r.get("match") or [])), [])
static = [r for r in routes if not any(h.endswith(".app.takosumi.test") for h in hosts(r))]
print(len(static))
')
if [[ -z "$STATIC_COUNT" || "$STATIC_COUNT" -lt 6 ]]; then
	echo "FAIL: Caddy admin returned $STATIC_COUNT static routes (expected ≥6)" >&2
	exit 1
fi

echo "OK route-registrar running + ticking; ${STATIC_COUNT} static route(s) preserved"
