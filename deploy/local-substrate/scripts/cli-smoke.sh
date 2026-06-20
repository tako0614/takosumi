#!/usr/bin/env bash
# Exercises the local worker-probe Deploy Control HTTP surface.
#
#   1. GET  /internal/v1/runner-profiles.
#   2. POST /internal/v1/plan-runs.
#   3. POST /internal/v1/apply-runs.
#   4. GET  /internal/v1/installations/{id}.
#   5. GET  /internal/v1/installations/{id}/deployments.
#
# Run: bash scripts/cli-smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
TOKEN="${TAKOSUMI_DEPLOY_CONTROL_TOKEN:-local-substrate-deploy-control-token}"
SPACE_ID="${TAKOSUMI_DEPLOY_CONTROL_SPACE_ID:-local-substrate-space}"
SOURCE_PATH="${TAKOSUMI_DEPLOY_CONTROL_SOURCE_PATH:-/workspace/examples/opentofu-basic}"
SERVICE_URL="${TAKOSUMI_SERVICE_URL:-https://service-worker.takosumi.test}"

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA — run scripts/up.sh first" >&2
	exit 1
fi

PLAN_REQUEST=$(cat <<EOF
{
  "spaceId": "$SPACE_ID",
  "source": {
    "kind": "local",
    "path": "$SOURCE_PATH"
  },
  "requiredProviders": []
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

get_json() {
	local path="$1"
	curl -sk --cacert "$CA" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
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

PROFILES_RESPONSE="$(get_json "/internal/v1/runner-profiles")"
require_code "runner profiles" "$PROFILES_RESPONSE" "200"

PLAN_RESPONSE="$(post_json "/internal/v1/plan-runs" "$PLAN_REQUEST")"
require_code "plan run create" "$PLAN_RESPONSE" "201"
PLAN_BODY="$(response_body "$PLAN_RESPONSE")"
PLAN_ID="$(printf '%s' "$PLAN_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin)["planRun"]["id"])
')"
PLAN_STATUS="$(printf '%s' "$PLAN_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin)["planRun"]["status"])
')"
PLAN_DIGEST="$(printf '%s' "$PLAN_BODY" | python3 -c '
import json, sys
print(json.load(sys.stdin)["planRun"].get("planDigest", ""))
')"
if [[ "$PLAN_STATUS" != "succeeded" ]]; then
	echo "FAIL: plan run status=$PLAN_STATUS (expected succeeded)" >&2
	echo "      response: $PLAN_BODY" >&2
	exit 1
fi
if [[ -z "$PLAN_DIGEST" ]]; then
	echo "FAIL: plan run did not return planDigest: $PLAN_BODY" >&2
	exit 1
fi

APPLY_REQUEST="{\"planRunId\":\"$PLAN_ID\",\"expected\":{\"planDigest\":\"$PLAN_DIGEST\"}}"
APPLY_RESPONSE="$(post_json "/internal/v1/apply-runs" "$APPLY_REQUEST")"
require_code "apply run create" "$APPLY_RESPONSE" "201"
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
	echo "FAIL: apply run produced deployment.status=$DEPLOYMENT_STATUS" >&2
	echo "      response: $APPLY_BODY" >&2
	exit 1
fi

GET_INSTALLATION_RESPONSE="$(get_json "/internal/v1/installations/$INSTALLATION_ID")"
require_code "get installation" "$GET_INSTALLATION_RESPONSE" "200"
LIST_DEPLOYMENTS_RESPONSE="$(get_json "/internal/v1/installations/$INSTALLATION_ID/deployments")"
require_code "list deployments" "$LIST_DEPLOYMENTS_RESPONSE" "200"

echo "OK deploy control installation=$INSTALLATION_ID deployment=$DEPLOYMENT_ID status=$DEPLOYMENT_STATUS digest=$PLAN_DIGEST"
