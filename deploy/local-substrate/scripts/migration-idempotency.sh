#!/usr/bin/env bash
# Asserts the local service-worker D1 schema is stable across worker restarts.
#
# The Cloudflare Worker local mirror uses CREATE TABLE IF NOT EXISTS for schema
# proper up/down migrations exist), so the only thing we can drill on is
# idempotency: starting the worker N times must produce the same schema
# every time. A change to the init SQL that's not safe to re-run (e.g. a
# CREATE INDEX on a column that now has duplicates) would fail this.
#
# Procedure:
#   1. Snapshot the current schema via sqlite3 .schema (D1 store is sqlite
#      under miniflare).
#   2. Force-recreate the worker container (re-runs initialize()).
#   3. Snapshot again; assert byte-identical.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SUBSTRATE_DIR"
source "$SCRIPT_DIR/compose-helpers.sh"

PROFILE="$(local_substrate_profile)"

materialize_d1() {
	local host
	for host in service-worker.takosumi.test service.takosumi.test; do
		curl -sk --max-time 5 --cacert "$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem" \
			--resolve "${host}:443:127.0.0.1" \
			-o /dev/null \
			"https://${host}/v1/capabilities" || true
	done
}

# 1. Snapshot the service worker's D1 sqlite via an AppArmor-compatible helper
#    container. `docker exec` is not available on some locked-down hosts, and
#    reading the named volume from a one-shot Python container is enough for a
#    read-only schema projection.
snapshot() {
	local out=$1
	local_substrate_docker_run --rm -i \
		-v local-substrate_takosumi-service-worker-data:/data:ro \
		python:3.13-alpine \
		python3 - <<'PY' > "$out"
import os
import sqlite3
best_sql = ""
best_path = ""
for root, _dirs, files in os.walk("/data/d1"):
    for name in files:
        if name.endswith(".sqlite"):
            sqlite_path = os.path.join(root, name)
            con = sqlite3.connect(f"file:{sqlite_path}?mode=ro&immutable=1", uri=True)
            rows = con.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").fetchall()
            sql = "\n".join(r[0] for r in rows)
            con.close()
            if len(sql) > len(best_sql):
                best_sql = sql
                best_path = sqlite_path
if not best_path:
    raise SystemExit("no .sqlite under /data/d1 in the worker volume")
if len(best_sql) < 100:
    raise SystemExit(f"no materialized D1 schema found under /data/d1 (best={best_path}, bytes={len(best_sql)})")
print(best_sql)
PY
}
materialize_d1
snapshot /tmp/schema-before.txt

SIZE_BEFORE=$(wc -c < /tmp/schema-before.txt)
if [[ "$SIZE_BEFORE" -lt 100 ]]; then
	echo "FAIL: schema snapshot suspiciously small ($SIZE_BEFORE bytes)" >&2
	cat /tmp/schema-before.txt >&2
	exit 1
fi

# 2. Recreate the service worker (forces initialize() to re-run against the same D1).
compose_substrate --profile "$PROFILE" up -d --force-recreate \
	takosumi-service-worker-build takosumi-service-worker >/dev/null 2>&1
# Give miniflare a moment to come up + run init.
sleep 5

# 3. Snapshot again, compare.
snapshot /tmp/schema-after.txt

if ! diff -q /tmp/schema-before.txt /tmp/schema-after.txt >/dev/null; then
	echo "FAIL: schema drifted after worker restart" >&2
	diff /tmp/schema-before.txt /tmp/schema-after.txt | head -20 >&2
	exit 1
fi

LINES=$(wc -l < /tmp/schema-before.txt)
echo "OK schema stable across restart ($LINES schema entries, $SIZE_BEFORE bytes)"
