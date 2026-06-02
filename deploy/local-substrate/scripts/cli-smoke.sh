#!/usr/bin/env bash
# Exercises the canonical installer HTTP surface (`POST /v1/installations*`).
# This is the same path the takosumi CLI uses for install / deploy / rollback;
# without this smoke, a regression in the public installer pipeline would only
# be caught in production.
#
#   1. POST /v1/installations/dry-run for the mounted source fixture fixture.
#   2. POST /v1/installations and assert deployment.status == "succeeded".
#   3. POST /v1/installations/{id}/deployments[/dry-run].
#   4. POST /v1/installations/{id}/rollback.
#
# Run: bash scripts/cli-smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
TOKEN="${TAKOSUMI_INSTALLER_TOKEN:-local-substrate-installer-token}"
LOCAL_CLOUD_SESSION_ID="${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID:-sess_local_substrate}"
SPACE_ID="${TAKOSUMI_INSTALLER_SPACE_ID:-local-substrate-space}"
SOURCE_PATH="${TAKOSUMI_INSTALLER_SOURCE_PATH:-/workspace/examples/direct-deploy}"
SERVICE_URL="${TAKOSUMI_SERVICE_URL:-https://accounts.takosumi.test}"

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA — run scripts/up.sh first" >&2
	exit 1
fi

INSTALL_REQUEST=$(cat <<EOF
{
  "spaceId": "$SPACE_ID",
  "source": {
    "kind": "local",
    "url": "$SOURCE_PATH"
  }
}
EOF
)

post_json() {
	local path="$1"
	local body="$2"
	curl -sk --cacert "$CA" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-d "$body" \
		-w "\n%{http_code}\n" \
		"$SERVICE_URL$path"
}

response_body() {
	printf '%s\n' "$1" | sed '$d'
}

response_code() {
	printf '%s\n' "$1" | tail -n 1
}

require_code() {
	local label="$1"
	local response="$2"
	local expected="$3"
	local actual
	actual="$(response_code "$response")"
	if [[ "$actual" != "$expected" ]]; then
		echo "FAIL: $label returned HTTP $actual (expected $expected)" >&2
		echo "      response: $(response_body "$response")" >&2
		exit 1
	fi
}

DRY_RESPONSE="$(post_json "/v1/installations/dry-run" "$INSTALL_REQUEST")"
require_code "installation dry-run" "$DRY_RESPONSE" "200"
DRY_BODY="$(response_body "$DRY_RESPONSE")"
EXPECTED_PIN="$(printf '%s' "$DRY_BODY" | python3 -c '
import json, sys
body = json.load(sys.stdin)
print(json.dumps(body["expected"], separators=(",", ":")))
')"
PLAN_DIGEST="$(printf '%s' "$DRY_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("planSnapshotDigest", ""))
')"

APPLY_REQUEST="$(printf '%s' "$INSTALL_REQUEST" | python3 -c '
import json, sys
body = json.load(sys.stdin)
body["expected"] = json.loads(sys.argv[1])
print(json.dumps(body, separators=(",", ":")))
' "$EXPECTED_PIN")"

APPLY_RESPONSE="$(post_json "/v1/installations" "$APPLY_REQUEST")"
require_code "installation apply" "$APPLY_RESPONSE" "201"
APPLY_BODY="$(response_body "$APPLY_RESPONSE")"
INSTALLATION_ID="$(printf '%s' "$APPLY_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin)["installation"]["id"])
')"
DEPLOYMENT_ID="$(printf '%s' "$APPLY_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin)["deployment"]["id"])
')"
DEPLOYMENT_STATUS="$(printf '%s' "$APPLY_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin)["deployment"]["status"])
')"

if [[ "$DEPLOYMENT_STATUS" != "succeeded" ]]; then
	echo "FAIL: installation apply produced deployment.status=$DEPLOYMENT_STATUS" >&2
	echo "      response: $APPLY_BODY" >&2
	exit 1
fi

DEPLOY_REQUEST="$(cat <<EOF
{
  "source": {
    "kind": "local",
    "url": "$SOURCE_PATH"
  }
}
EOF
)"
DEPLOY_DRY_RESPONSE="$(post_json "/v1/installations/$INSTALLATION_ID/deployments/dry-run" "$DEPLOY_REQUEST")"
require_code "deployment dry-run" "$DEPLOY_DRY_RESPONSE" "200"
DEPLOY_DRY_BODY="$(response_body "$DEPLOY_DRY_RESPONSE")"
DEPLOY_EXPECTED="$(printf '%s' "$DEPLOY_DRY_BODY" | python3 -c '
import json, sys
body = json.load(sys.stdin)
print(json.dumps(body["expected"], separators=(",", ":")))
')"

DEPLOY_APPLY_REQUEST="$(printf '%s' "$DEPLOY_REQUEST" | python3 -c '
import json, sys
body = json.load(sys.stdin)
body["expected"] = json.loads(sys.argv[1])
print(json.dumps(body, separators=(",", ":")))
' "$DEPLOY_EXPECTED")"

DEPLOY_RESPONSE="$(post_json "/v1/installations/$INSTALLATION_ID/deployments" "$DEPLOY_APPLY_REQUEST")"
require_code "deployment apply" "$DEPLOY_RESPONSE" "201"

ROLLBACK_REQUEST="{\"deploymentId\":\"$DEPLOYMENT_ID\"}"
ROLLBACK_RESPONSE="$(post_json "/v1/installations/$INSTALLATION_ID/rollback" "$ROLLBACK_REQUEST")"
require_code "rollback" "$ROLLBACK_RESPONSE" "200"

echo "OK installer installation=$INSTALLATION_ID deployment=$DEPLOYMENT_ID status=$DEPLOYMENT_STATUS digest=$PLAN_DIGEST"

# B6: also assert installer-mock returns real source fixture-derived changes
# (fixture-hit path, not the empty fallback).
PREVIEW=$(curl -sk --cacert "$CA" \
	-H "Authorization: Bearer $LOCAL_CLOUD_SESSION_ID" \
	-H "Content-Type: application/json" \
	-d '{"spaceId":"space_local","source":{"kind":"git","url":"https://github.com/tako0614/yurucommu.git","ref":"main"}}' \
	"https://accounts.takosumi.test/v1/installations/dry-run")
CHANGE_COUNT=$(echo "$PREVIEW" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(len(d.get('changes') or []))")
if [[ "$CHANGE_COUNT" -lt 3 ]]; then
	echo "FAIL: installer dry-run returned $CHANGE_COUNT changes for yurucommu (expected >=3)" >&2
	echo "      response: $PREVIEW" >&2
	exit 1
fi

echo "OK installer dry-run yurucommu → $CHANGE_COUNT source fixture changes (fixture-hit)"
