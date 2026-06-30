#!/usr/bin/env bash
# Exercises the real upload deploy path used by `takosumi deploy`.
#
#   1. GET  /internal/v1/runner-profiles.
#   2. POST /internal/v1/workspaces.
#   3. tar.zst a plain OpenTofu Capsule.
#   4. POST /internal/v1/workspaces/{workspaceId}/uploads.
#   5. POST /internal/v1/deploy -> real plan Run.
#   6. POST /internal/v1/runs/{planRunId}/approve when approval is required.
#   7. POST /internal/v1/apply-runs -> real apply Run.
#   8. GET  /internal/v1/capsules/{id} and state versions.
#
# Run: bash scripts/cli-smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SUBSTRATE_DIR/../.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
TOKEN="${TAKOSUMI_DEPLOY_CONTROL_TOKEN:-local-substrate-deploy-control-token}"
SOURCE_PATH="${TAKOSUMI_DEPLOY_CONTROL_SOURCE_PATH:-$REPO_ROOT/opentofu-modules/core/module}"
SERVICE_URL="${TAKOSUMI_SERVICE_URL:-https://app.takosumi.test}"
RUN_SUFFIX="$(date +%s%N)"
APP_NAME="cli-smoke-$RUN_SUFFIX"

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA — run scripts/up.sh first" >&2
	exit 1
fi

if [[ ! -d "$SOURCE_PATH" ]]; then
	echo "OpenTofu source path not found: $SOURCE_PATH" >&2
	exit 1
fi

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

post_binary() {
	local path="$1"
	local file="$2"
	curl -sk --cacert "$CA" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/zstd" \
		--data-binary "@$file" \
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

json_field() {
	local expression="$1"
	python3 -c "import json,sys; data=json.load(sys.stdin); print($expression)"
}

PROFILES_RESPONSE="$(get_json "/internal/v1/runner-profiles")"
require_code "runner profiles" "$PROFILES_RESPONSE" "200"
PROFILE_IDS="$(response_body "$PROFILES_RESPONSE" | json_field "','.join(p['id'] for p in data.get('runnerProfiles') or [])")"
[[ -n "$PROFILE_IDS" ]] || {
	echo "FAIL: /internal/v1/runner-profiles returned no profiles" >&2
	exit 1
}

SPACE_REQUEST=$(cat <<EOF
{
  "handle": "cli-smoke-$RUN_SUFFIX",
  "displayName": "CLI smoke $RUN_SUFFIX",
  "type": "personal",
  "ownerUserId": "local-substrate-cli-smoke"
}
EOF
)
SPACE_RESPONSE="$(post_json "/internal/v1/workspaces" "$SPACE_REQUEST")"
require_code "space create" "$SPACE_RESPONSE" "201"
SPACE_ID="$(response_body "$SPACE_RESPONSE" | json_field "data['space']['id']")"

ARCHIVE="$(mktemp -t takosumi-cli-smoke.XXXXXX.tar.zst)"
trap 'rm -f "$ARCHIVE"' EXIT
tar --zstd -cf "$ARCHIVE" -C "$SOURCE_PATH" .

UPLOAD_RESPONSE="$(post_binary "/internal/v1/workspaces/$SPACE_ID/uploads?path=." "$ARCHIVE")"
require_code "upload snapshot" "$UPLOAD_RESPONSE" "201"
SNAPSHOT_ID="$(response_body "$UPLOAD_RESPONSE" | json_field "data['snapshot']['id']")"
SNAPSHOT_DIGEST="$(response_body "$UPLOAD_RESPONSE" | json_field "data['snapshot']['archiveDigest']")"

DEPLOY_REQUEST=$(cat <<EOF
{
  "spaceId": "$SPACE_ID",
  "name": "$APP_NAME",
  "environment": "preview",
  "snapshotId": "$SNAPSHOT_ID",
  "vars": {
    "base_domain": "$APP_NAME.takosumi.test",
    "display_name": "CLI smoke"
  }
}
EOF
)
DEPLOY_RESPONSE="$(post_json "/internal/v1/deploy" "$DEPLOY_REQUEST")"
require_code "deploy upload plan" "$DEPLOY_RESPONSE" "200"
DEPLOY_BODY="$(response_body "$DEPLOY_RESPONSE")"
PLAN_ID="$(printf '%s' "$DEPLOY_BODY" | json_field "(data.get('planRun') or data['run'])['id']")"
PLAN_STATUS="$(printf '%s' "$DEPLOY_BODY" | json_field "(data.get('planRun') or data['run'])['status']")"
INSTALLATION_ID="$(printf '%s' "$DEPLOY_BODY" | json_field "data['installation']['id']")"

if [[ "$PLAN_STATUS" == "waiting_approval" ]]; then
	APPROVE_RESPONSE="$(post_json "/internal/v1/runs/$PLAN_ID/approve" '{"reason":"local-substrate cli smoke"}')"
	require_code "approve plan run" "$APPROVE_RESPONSE" "200"
	PLAN_RESPONSE="$(get_json "/internal/v1/runs/$PLAN_ID")"
	require_code "read approved plan run" "$PLAN_RESPONSE" "200"
	PLAN_STATUS="$(response_body "$PLAN_RESPONSE" | json_field "data['run']['status']")"
elif [[ "$PLAN_STATUS" == "succeeded" ]]; then
	PLAN_RESPONSE="$(get_json "/internal/v1/runs/$PLAN_ID")"
	require_code "read plan run" "$PLAN_RESPONSE" "200"
else
	echo "FAIL: plan run status=$PLAN_STATUS (expected succeeded or waiting_approval)" >&2
	echo "      response: $DEPLOY_BODY" >&2
	exit 1
fi

PLAN_BODY="$(response_body "$PLAN_RESPONSE")"
APPLY_REQUEST="$(printf '%s' "$PLAN_BODY" | python3 -c '
import json, sys
run = json.load(sys.stdin)["run"]
expected = run.get("applyExpected")
if not expected:
  raise SystemExit("plan Run response did not include applyExpected")
print(json.dumps({"planRunId": run["id"], "expected": expected}))
')"
APPLY_RESPONSE="$(post_json "/internal/v1/apply-runs" "$APPLY_REQUEST")"
require_code "apply run create" "$APPLY_RESPONSE" "201"
APPLY_BODY="$(response_body "$APPLY_RESPONSE")"
APPLY_ID="$(printf '%s' "$APPLY_BODY" | json_field "data['applyRun']['id']")"
APPLY_STATUS="$(printf '%s' "$APPLY_BODY" | json_field "data['applyRun']['status']")"

if [[ "$APPLY_STATUS" != "succeeded" ]]; then
	echo "FAIL: apply run status=$APPLY_STATUS (expected succeeded)" >&2
	echo "      response: $APPLY_BODY" >&2
	exit 1
fi

GET_INSTALLATION_RESPONSE="$(get_json "/internal/v1/capsules/$INSTALLATION_ID")"
require_code "get installation" "$GET_INSTALLATION_RESPONSE" "200"
LIST_DEPLOYMENTS_RESPONSE="$(get_json "/internal/v1/capsules/$INSTALLATION_ID/state-versions")"
require_code "list deployments" "$LIST_DEPLOYMENTS_RESPONSE" "200"
DEPLOYMENT_COUNT="$(response_body "$LIST_DEPLOYMENTS_RESPONSE" | json_field "len(data.get('deployments') or [])")"
[[ "$DEPLOYMENT_COUNT" -gt 0 ]] || {
	echo "FAIL: no deployment was recorded for $INSTALLATION_ID" >&2
	echo "      response: $(response_body "$LIST_DEPLOYMENTS_RESPONSE")" >&2
	exit 1
}

echo "OK upload deploy space=$SPACE_ID installation=$INSTALLATION_ID plan=$PLAN_ID apply=$APPLY_ID snapshot=$SNAPSHOT_ID digest=$SNAPSHOT_DIGEST profiles=$PROFILE_IDS"
