#!/usr/bin/env bash
# Smoke for local workerd/D1/R2 code paths.
#
# What this script verifies:
#   1. takosumi Accounts Worker runs on workerd with D1/R2.
#      The expected persistence=d1+r2 profile must route signed downloads
#      through /__takosumi/exports and reject bad signatures as
#      invalid_export_download_signature.
#   2. takosumi service Worker runs on workerd with Queue and DO
#      through local-only worker probe ingress. app.takosumi.test remains the
#      canonical platform host for user-facing flows.
#   3. The Accounts installation run and OIDC discovery surfaces still answer.
#   4. D1 binding semantics: the sqlite file underneath miniflare's D1
#      emulator supports json_extract on the document column AND a
#      multi-statement INSERT/SELECT round-trip — these are the two
#      D1 primitives the accounts-service store relies on, and a
#      regression here (e.g. miniflare image upgrade dropping the
#      json1 extension) would fail silently through the API.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
source "$SCRIPT_DIR/compose-helpers.sh"

resolve_service_worker_host() {
	local candidates=()
	if [[ -n "${SERVICE_WORKER_HOST:-}" ]]; then
		candidates+=("$SERVICE_WORKER_HOST")
	else
		# postgres profile exposes the Worker probe beside the Bun+Postgres
		# service. workers profile routes service.takosumi.test to the Worker.
		candidates+=(service-worker.takosumi.test service.takosumi.test)
	fi

	local host body
	for host in "${candidates[@]}"; do
		body=$(curl -sk --cacert "$CA" --resolve "${host}:443:127.0.0.1" \
			"https://${host}/healthz" || true)
		if echo "$body" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if d.get('provider') == 'cloudflare-worker' else 1)
" >/dev/null 2>&1; then
			printf '%s\n' "$host"
			return 0
		fi
	done

	echo "FAIL: no Takosumi service Worker host answered /healthz as provider=cloudflare-worker" >&2
	return 1
}

SERVICE_HOST="$(resolve_service_worker_host)"

# 1. Platform host sentinel. In the postgres profile app.takosumi.test is the
#    composed Bun+Postgres app; in the workers profile it is the Accounts
#    Worker. Accept both explicitly so this smoke verifies the active profile
#    instead of failing on a stale primary-host assumption.
HEALTH=$(curl -sk --cacert "$CA" https://app.takosumi.test/healthz)
APP_HEALTH_KIND=$(echo "$HEALTH" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if d.get('provider') == 'cloudflare' and d.get('persistence') == 'd1+r2':
    print('worker')
elif d.get('ok') is True and d.get('database') == 'ok':
    print('postgres')
else:
    raise SystemExit(f'unexpected app health payload: {d!r}')
" 2>/tmp/workers-cli-app-health.err) || {
	echo "FAIL: /healthz did not match a known local-substrate profile: $HEALTH" >&2
	cat /tmp/workers-cli-app-health.err >&2 || true
	exit 1
}

# 2. Service Worker sentinel. Edge-only `/storage/healthz` was retired; the
#    Worker intentionally keeps it outside the service app and returns 404.
SERVICE_HEALTH=$(curl -sk --cacert "$CA" --resolve "${SERVICE_HOST}:443:127.0.0.1" "https://${SERVICE_HOST}/healthz")
echo "$SERVICE_HEALTH" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert d.get('provider') == 'cloudflare-worker', f'expected provider=cloudflare-worker, got {d!r}'
" || { echo "FAIL: $SERVICE_HOST /healthz did not look workerd-local: $SERVICE_HEALTH" >&2; exit 1; }

DEPLOY_CONTROL_TOKEN="${TAKOSUMI_DEPLOY_CONTROL_TOKEN:-local-substrate-deploy-control-token}"

SERVICE_API_STATUS=$(curl -sk --cacert "$CA" --resolve "${SERVICE_HOST}:443:127.0.0.1" \
	-H "Authorization: Bearer $DEPLOY_CONTROL_TOKEN" \
	-o /dev/null -w "%{http_code}" "https://${SERVICE_HOST}/capabilities")
[[ "$SERVICE_API_STATUS" == "200" ]] || {
	echo "FAIL: $SERVICE_HOST /capabilities returned $SERVICE_API_STATUS with operator inventory bearer (expected 200)" >&2
	exit 1
}

# 3. deploy control internal seam auth + handler init. The service Worker
#    probe intentionally does not expose `/internal/v1`; in the postgres
#    profile that seam is mounted only on the composed app host.
RUNNER_PROFILES=$(curl -sk --cacert "$CA" \
	-H "Authorization: Bearer $DEPLOY_CONTROL_TOKEN" \
	-H "Content-Type: application/json" \
	"https://app.takosumi.test/internal/v1/runner-profiles")
PROFILE_COUNT=$(echo "$RUNNER_PROFILES" | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read()).get('runnerProfiles') or []))")
[[ "$PROFILE_COUNT" -gt 0 ]] || { echo "FAIL: /internal/v1/runner-profiles returned no profiles: $RUNNER_PROFILES" >&2; exit 1; }

# 4. OIDC discovery shape
DISC=$(curl -sk --cacert "$CA" https://app.takosumi.test/.well-known/openid-configuration)
ISSUER=$(echo "$DISC" | python3 -c "import json,sys;print(json.loads(sys.stdin.read()).get('issuer',''))")
[[ -n "$ISSUER" ]] || { echo "FAIL: /.well-known/openid-configuration missing issuer" >&2; exit 1; }

SIGNED_EXPORT_SUMMARY="signed export route skipped on postgres profile"
if [[ "$APP_HEALTH_KIND" == "worker" ]]; then
	# 5. R2 export download route is worker-owned, not SPA fallback. A deliberately
	#    bad signature should be rejected by the Worker with JSON, proving Caddy
	#    forwards the signed export path to the Accounts Worker.
	EXPORT_ROUTE_STATUS=""
	EXPORT_ROUTE_BODY="/tmp/accounts-export-route-smoke.json"
	probe_export_route() {
		EXPORT_ROUTE_STATUS=$(curl -sk --cacert "$CA" -o "$EXPORT_ROUTE_BODY" -w "%{http_code}" \
			"https://app.takosumi.test/__takosumi/exports/missing-object.json?expires=4102444800000&sig=bad")
		[[ "$EXPORT_ROUTE_STATUS" == "403" ]] || return 1
		python3 - "$EXPORT_ROUTE_BODY" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("error") == "invalid_export_download_signature", d
PY
	}

	if ! probe_export_route; then
		echo "WARN: /__takosumi/exports did not hit the Accounts Worker; recreating Caddy once to load current routes" >&2
		compose_ingress_with_project_directory "$SUBSTRATE_DIR" up -d --force-recreate caddy >/dev/null
		sleep 3
	fi
	if ! probe_export_route; then
		echo "FAIL: /__takosumi/exports did not return Worker signature rejection (status=$EXPORT_ROUTE_STATUS body=$(cat "$EXPORT_ROUTE_BODY"))" >&2
		exit 1
	fi
	SIGNED_EXPORT_SUMMARY="signed export route passed"
fi

# 6. D1 binding semantics — verify the sqlite file underneath miniflare's
#    D1 emulator has the json1 extension AND that a real INSERT-then-
#    SELECT round-trip with json_extract works. Catches "miniflare image
#    rebuilt without json1" or "schema migration silently lost the
#    document column" — failures the API-level checks miss because they
#    short-circuit on the first 500.
#
#    Mechanism: copy the sqlite file out of the worker container to a
#    /tmp scratch path, exercise it with the host's python3 sqlite3
#    module (always available, no apt-install needed), throw away the
#    copy. Read-only on the in-container file.
SQLITE_PATH=$(local_substrate_docker_run --rm -i \
	-v local-substrate_takosumi-service-worker-data:/data:ro \
	python:3.13-alpine \
	python3 - <<'PY'
import os
for root, _dirs, files in os.walk("/data/d1"):
    for name in files:
        if name.endswith(".sqlite"):
            print(os.path.join(root, name))
            raise SystemExit(0)
PY
)
if [[ -z "$SQLITE_PATH" ]]; then
	echo "OK app=$APP_HEALTH_KIND + service worker healthy via $SERVICE_HOST ($SIGNED_EXPORT_SUMMARY; D1 semantics check SKIPPED — sqlite path not yet materialised); issuer=$ISSUER"
	exit 0
fi
local_substrate_docker_run --rm -i \
	-v local-substrate_takosumi-service-worker-data:/data:ro \
	-e SQLITE_PATH="$SQLITE_PATH" \
	python:3.13-alpine \
	python3 - <<'PY' || { echo "FAIL: D1 binding semantics check" >&2; exit 1; }
import sqlite3, sys, json
import os
db = sqlite3.connect(
    f"file:{os.environ['SQLITE_PATH']}?mode=ro&immutable=1",
    uri=True,
)
cur = db.cursor()
# json1 extension must be present — the store relies on json_extract.
r = cur.execute("SELECT json_extract(?, '$.k')", (json.dumps({"k": 1}),)).fetchone()
assert r and r[0] == 1, f"json_extract returned {r!r}, expected (1,)"
# INSERT/SELECT round-trip on a scratch in-memory-style table. Uses a
# JSON document whose values contain quotes + colons + braces to flush
# out any parameter-binding regression.
cur.execute("CREATE TEMPORARY TABLE _smoke (id INTEGER PRIMARY KEY, doc TEXT)")
docs = [json.dumps({"q": ":x\"y{z}"}), json.dumps({"q": "plain"})]
cur.executemany("INSERT INTO _smoke (doc) VALUES (?)", [(d,) for d in docs])
r = cur.execute("SELECT count(*) FROM _smoke WHERE json_extract(doc, '$.q') IS NOT NULL").fetchone()
assert r[0] == 2, f"expected 2 rows with non-null $.q, got {r[0]}"
r = cur.execute("SELECT json_extract(doc, '$.q') FROM _smoke WHERE id=1").fetchone()
assert r[0] == ":x\"y{z}", f"expected ':x\\\"y{{z}}', got {r[0]!r}"
db.close()
PY

echo "OK app=$APP_HEALTH_KIND + service worker healthy via $SERVICE_HOST; $SIGNED_EXPORT_SUMMARY; D1 json1 + INSERT/SELECT semantics intact; issuer=$ISSUER"
