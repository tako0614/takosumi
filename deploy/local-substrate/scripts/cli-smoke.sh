#!/usr/bin/env bash
# Exercises the real Git Source -> Capsule -> plan/apply path used by
# `takosumi deploy`.
#
#   1. GET  /internal/v1/runner-profiles.
#   2. POST /internal/v1/workspaces.
#   3. POST /internal/v1/sources.
#   4. POST /internal/v1/sources/{sourceId}/sync and wait for the snapshot.
#   5. POST /internal/v1/workspaces/{workspaceId}/capsules.
#   6. POST /internal/v1/capsules/{capsuleId}/plan.
#   7. POST /internal/v1/runs/{planRunId}/approve when approval is required.
#   8. POST /internal/v1/apply-runs -> real apply Run.
#   9. GET  /internal/v1/capsules/{id} and state versions.
#
# Run: bash scripts/cli-smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SUBSTRATE_DIR/../.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
TOKEN="${TAKOSUMI_DEPLOY_CONTROL_TOKEN:-local-substrate-deploy-control-token}"
SOURCE_GIT="${TAKOSUMI_DEPLOY_CONTROL_SOURCE_GIT:-https://github.com/tako0614/takosumi.git}"
SOURCE_REF="${TAKOSUMI_DEPLOY_CONTROL_SOURCE_REF:-main}"
SOURCE_MODULE_PATH="${TAKOSUMI_DEPLOY_CONTROL_SOURCE_PATH:-opentofu-modules/core/module}"
INSTALL_CONFIG_ID="${TAKOSUMI_DEPLOY_CONTROL_INSTALL_CONFIG_ID:-cfg-default-opentofu-capsule}"
CAPSULE_VARS_JSON="${TAKOSUMI_DEPLOY_CONTROL_VARS_JSON:-}"
EXPECTED_OUTPUTS_JSON="${TAKOSUMI_DEPLOY_CONTROL_EXPECTED_OUTPUTS_JSON:-}"
DESTROY_AFTER_APPLY="${TAKOSUMI_DEPLOY_CONTROL_DESTROY_AFTER_APPLY:-0}"
source "$SCRIPT_DIR/compose-helpers.sh"
INGRESS_IP="$(local_substrate_ingress_ip)"
PROFILE="$(local_substrate_profile)"
case "$PROFILE" in
	workers) DEFAULT_SERVICE_URL="https://service.takosumi.test" ;;
	# app.takosumi.test intentionally hides /internal/*. The postgres profile
	# keeps the composed Worker mirror on this local-only probe host so the
	# internal run-ledger smoke never widens the public Accounts ingress.
	postgres) DEFAULT_SERVICE_URL="https://service-worker.takosumi.test" ;;
esac
SERVICE_URL="${TAKOSUMI_SERVICE_URL:-$DEFAULT_SERVICE_URL}"
CURL_RESOLVE=()
if [[ "$SERVICE_URL" =~ ^https://([a-z0-9.-]+\.takosumi\.test)(/|$) ]]; then
	CURL_RESOLVE=(--resolve "${BASH_REMATCH[1]}:443:${INGRESS_IP}")
fi
RUN_SUFFIX="$(date +%s%N)"
APP_NAME="cli-smoke-$RUN_SUFFIX"

if [[ -z "$CAPSULE_VARS_JSON" ]]; then
	CAPSULE_VARS_JSON=$(APP_NAME="$APP_NAME" python3 -c '
import json, os
print(json.dumps({
  "base_domain": f"{os.environ["APP_NAME"]}.takosumi.test",
  "display_name": "CLI smoke",
}))
')
fi
[[ -n "$EXPECTED_OUTPUTS_JSON" ]] || EXPECTED_OUTPUTS_JSON='{}'
python3 -c '
import json, sys
for label, raw in (("vars", sys.argv[1]), ("expected outputs", sys.argv[2])):
  parsed = json.loads(raw)
  if not isinstance(parsed, dict):
    raise SystemExit(f"{label} JSON must be an object")
' "$CAPSULE_VARS_JSON" "$EXPECTED_OUTPUTS_JSON"
if [[ "$DESTROY_AFTER_APPLY" != "0" && "$DESTROY_AFTER_APPLY" != "1" ]]; then
	echo "TAKOSUMI_DEPLOY_CONTROL_DESTROY_AFTER_APPLY must be 0 or 1" >&2
	exit 1
fi

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA — run scripts/up.sh first" >&2
	exit 1
fi

post_json() {
	local path="$1"
	local body="$2"
	curl -sk --cacert "$CA" \
		"${CURL_RESOLVE[@]}" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-d "$body" \
		-w "\n%{http_code}\n" \
		"$SERVICE_URL$path"
}

get_json() {
	local path="$1"
	curl -sk --cacert "$CA" \
		"${CURL_RESOLVE[@]}" \
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

wait_for_run() {
	local run_id="$1"
	local label="$2"
	local response status
	for _ in $(seq 1 120); do
		response="$(get_json "/internal/v1/runs/$run_id")"
		require_code "read $label run" "$response" "200"
		status="$(response_body "$response" | json_field "data['run']['status']")"
		case "$status" in
			succeeded|waiting_approval)
				printf '%s' "$(response_body "$response")"
				return 0
				;;
			failed|canceled)
				echo "FAIL: $label run $run_id ended with status=$status" >&2
				echo "      response: $(response_body "$response")" >&2
				exit 1
				;;
		esac
		sleep 1
	done
	echo "FAIL: $label run $run_id did not finish within timeout" >&2
	exit 1
}

PROFILES_RESPONSE="$(get_json "/internal/v1/runner-profiles")"
require_code "runner profiles" "$PROFILES_RESPONSE" "200"
PROFILE_IDS="$(response_body "$PROFILES_RESPONSE" | json_field "','.join(p['id'] for p in data.get('runnerProfiles') or [])")"
[[ -n "$PROFILE_IDS" ]] || {
	echo "FAIL: /internal/v1/runner-profiles returned no profiles" >&2
	exit 1
}

WORKSPACE_REQUEST=$(cat <<EOF
{
  "handle": "cli-smoke-$RUN_SUFFIX",
  "displayName": "CLI smoke $RUN_SUFFIX",
  "type": "personal",
  "ownerUserId": "local-substrate-cli-smoke"
}
EOF
)
WORKSPACE_RESPONSE="$(post_json "/internal/v1/workspaces" "$WORKSPACE_REQUEST")"
require_code "workspace create" "$WORKSPACE_RESPONSE" "201"
WORKSPACE_ID="$(response_body "$WORKSPACE_RESPONSE" | json_field "data['workspace']['id']")"

SOURCE_REQUEST=$(cat <<EOF
{
  "workspaceId": "$WORKSPACE_ID",
  "name": "$APP_NAME",
  "url": "$SOURCE_GIT",
  "defaultRef": "$SOURCE_REF",
  "defaultPath": "$SOURCE_MODULE_PATH"
}
EOF
)
SOURCE_RESPONSE="$(post_json "/internal/v1/sources" "$SOURCE_REQUEST")"
require_code "source create" "$SOURCE_RESPONSE" "201"
SOURCE_ID="$(response_body "$SOURCE_RESPONSE" | json_field "data['source']['id']")"

SYNC_RESPONSE="$(post_json "/internal/v1/sources/$SOURCE_ID/sync" '{}')"
require_code "source sync create" "$SYNC_RESPONSE" "201"
SYNC_ID="$(response_body "$SYNC_RESPONSE" | json_field "data['run']['id']")"
wait_for_run "$SYNC_ID" "source sync" >/dev/null
SNAPSHOTS_RESPONSE="$(get_json "/internal/v1/sources/$SOURCE_ID/snapshots")"
require_code "source snapshots" "$SNAPSHOTS_RESPONSE" "200"
SNAPSHOT_COUNT="$(response_body "$SNAPSHOTS_RESPONSE" | json_field "len(data.get('snapshots') or [])")"
[[ "$SNAPSHOT_COUNT" -gt 0 ]] || {
	echo "FAIL: source sync recorded no snapshots for $SOURCE_ID" >&2
	echo "      response: $(response_body "$SNAPSHOTS_RESPONSE")" >&2
	exit 1
}

CAPSULE_REQUEST=$(WORKSPACE_ID="$WORKSPACE_ID" APP_NAME="$APP_NAME" \
	SOURCE_ID="$SOURCE_ID" INSTALL_CONFIG_ID="$INSTALL_CONFIG_ID" \
	CAPSULE_VARS_JSON="$CAPSULE_VARS_JSON" python3 -c '
import json, os
print(json.dumps({
  "name": os.environ["APP_NAME"],
  "environment": "preview",
  "sourceId": os.environ["SOURCE_ID"],
  "installConfigId": os.environ["INSTALL_CONFIG_ID"],
  "runnerId": "opentofu-default",
  "vars": json.loads(os.environ["CAPSULE_VARS_JSON"]),
}))
')
CAPSULE_RESPONSE="$(post_json "/internal/v1/workspaces/$WORKSPACE_ID/capsules" "$CAPSULE_REQUEST")"
require_code "capsule create" "$CAPSULE_RESPONSE" "201"
CAPSULE_ID="$(response_body "$CAPSULE_RESPONSE" | json_field "data['capsule']['id']")"

PLAN_RESPONSE="$(post_json "/internal/v1/capsules/$CAPSULE_ID/plan" '{}')"
require_code "capsule plan create" "$PLAN_RESPONSE" "201"
PLAN_BODY="$(response_body "$PLAN_RESPONSE")"
PLAN_ID="$(printf '%s' "$PLAN_BODY" | json_field "data['run']['id']")"
PLAN_STATUS="$(printf '%s' "$PLAN_BODY" | json_field "data['run']['status']")"

if [[ "$PLAN_STATUS" == "queued" || "$PLAN_STATUS" == "running" ]]; then
	PLAN_BODY="$(wait_for_run "$PLAN_ID" "plan")"
	PLAN_STATUS="$(printf '%s' "$PLAN_BODY" | json_field "data['run']['status']")"
fi

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
	echo "      response: $PLAN_BODY" >&2
	exit 1
fi

PLAN_BODY="$(response_body "$PLAN_RESPONSE")"
APPLY_REQUEST="$(printf '%s' "$PLAN_BODY" | python3 -c '
import json, sys
run = json.load(sys.stdin)["run"]
public_expected = run.get("applyExpected")
if not public_expected:
  raise SystemExit("plan Run response did not include applyExpected")
expected = dict(public_expected)
plan_run_id = expected.pop("planId", None)
runner_profile_id = expected.pop("runnerId", None)
if plan_run_id != run["id"]:
  raise SystemExit("plan Run applyExpected.planId did not match run.id")
if not runner_profile_id:
  raise SystemExit("plan Run applyExpected did not include runnerId")
expected["planRunId"] = plan_run_id
expected["runnerProfileId"] = runner_profile_id
print(json.dumps({"planRunId": run["id"], "expected": expected}))
')"
APPLY_RESPONSE="$(post_json "/internal/v1/apply-runs" "$APPLY_REQUEST")"
require_code "apply run create" "$APPLY_RESPONSE" "201"
APPLY_BODY="$(response_body "$APPLY_RESPONSE")"
APPLY_ID="$(printf '%s' "$APPLY_BODY" | json_field "data['applyRun']['id']")"
APPLY_STATUS="$(printf '%s' "$APPLY_BODY" | json_field "data['applyRun']['status']")"

if [[ "$APPLY_STATUS" == "queued" || "$APPLY_STATUS" == "running" ]]; then
	APPLY_BODY="$(wait_for_run "$APPLY_ID" "apply")"
	APPLY_STATUS="$(printf '%s' "$APPLY_BODY" | json_field "data['run']['status']")"
fi

if [[ "$APPLY_STATUS" != "succeeded" ]]; then
	echo "FAIL: apply run status=$APPLY_STATUS (expected succeeded)" >&2
	echo "      response: $APPLY_BODY" >&2
	exit 1
fi

GET_CAPSULE_RESPONSE="$(get_json "/internal/v1/capsules/$CAPSULE_ID")"
require_code "get capsule" "$GET_CAPSULE_RESPONSE" "200"
LIST_STATE_VERSIONS_RESPONSE="$(get_json "/internal/v1/capsules/$CAPSULE_ID/state-versions")"
require_code "list state versions" "$LIST_STATE_VERSIONS_RESPONSE" "200"
STATE_VERSION_COUNT="$(response_body "$LIST_STATE_VERSIONS_RESPONSE" | json_field "len(data.get('stateVersions') or [])")"
[[ "$STATE_VERSION_COUNT" -gt 0 ]] || {
	echo "FAIL: no StateVersion was recorded for $CAPSULE_ID" >&2
	echo "      response: $(response_body "$LIST_STATE_VERSIONS_RESPONSE")" >&2
	exit 1
}

OUTPUT_RESPONSE="$(get_json "/internal/v1/capsules/$CAPSULE_ID/outputs")"
require_code "get capsule outputs" "$OUTPUT_RESPONSE" "200"
OUTPUT_BODY="$(response_body "$OUTPUT_RESPONSE")"
OUTPUT_SUMMARY="$(printf '%s' "$OUTPUT_BODY" | EXPECTED_OUTPUTS_JSON="$EXPECTED_OUTPUTS_JSON" python3 -c '
import json, os, sys
body = json.load(sys.stdin)["output"]
actual = {}
actual.update(body.get("publicOutputs") or {})
actual.update(body.get("workspaceOutputs") or {})
expected = json.loads(os.environ["EXPECTED_OUTPUTS_JSON"])
missing = {
  key: {"expected": value, "actual": actual.get(key)}
  for key, value in expected.items()
  if actual.get(key) != value
}
if missing:
  raise SystemExit(f"capsule output mismatch: {json.dumps(missing, sort_keys=True)}")
print(json.dumps(actual, sort_keys=True, separators=(",", ":")))
')"

DESTROY_ID="none"
if [[ "$DESTROY_AFTER_APPLY" == "1" ]]; then
	DESTROY_PLAN_RESPONSE="$(post_json "/internal/v1/capsules/$CAPSULE_ID/destroy-plan" '{}')"
	require_code "destroy plan create" "$DESTROY_PLAN_RESPONSE" "201"
	DESTROY_PLAN_BODY="$(response_body "$DESTROY_PLAN_RESPONSE")"
	DESTROY_PLAN_ID="$(printf '%s' "$DESTROY_PLAN_BODY" | json_field "data['run']['id']")"
	DESTROY_PLAN_STATUS="$(printf '%s' "$DESTROY_PLAN_BODY" | json_field "data['run']['status']")"
	if [[ "$DESTROY_PLAN_STATUS" == "queued" || "$DESTROY_PLAN_STATUS" == "running" ]]; then
		DESTROY_PLAN_BODY="$(wait_for_run "$DESTROY_PLAN_ID" "destroy plan")"
		DESTROY_PLAN_STATUS="$(printf '%s' "$DESTROY_PLAN_BODY" | json_field "data['run']['status']")"
	fi
	if [[ "$DESTROY_PLAN_STATUS" != "waiting_approval" ]]; then
		echo "FAIL: destroy plan status=$DESTROY_PLAN_STATUS (expected waiting_approval)" >&2
		echo "      response: $DESTROY_PLAN_BODY" >&2
		exit 1
	fi
	DESTROY_APPROVE_RESPONSE="$(post_json "/internal/v1/runs/$DESTROY_PLAN_ID/approve" '{"reason":"local-substrate lifecycle smoke"}')"
	require_code "approve destroy plan" "$DESTROY_APPROVE_RESPONSE" "200"
	DESTROY_PLAN_RESPONSE="$(get_json "/internal/v1/runs/$DESTROY_PLAN_ID")"
	require_code "read approved destroy plan" "$DESTROY_PLAN_RESPONSE" "200"
	DESTROY_APPLY_REQUEST="$(response_body "$DESTROY_PLAN_RESPONSE" | python3 -c '
import json, sys
run = json.load(sys.stdin)["run"]
expected = dict(run.get("applyExpected") or {})
plan_run_id = expected.pop("planId", None)
runner_profile_id = expected.pop("runnerId", None)
if plan_run_id != run["id"] or not runner_profile_id:
  raise SystemExit("destroy PlanRun did not expose a valid applyExpected guard")
expected["planRunId"] = plan_run_id
expected["runnerProfileId"] = runner_profile_id
print(json.dumps({"planRunId": run["id"], "expected": expected}))
')"
	DESTROY_APPLY_RESPONSE="$(post_json "/internal/v1/apply-runs" "$DESTROY_APPLY_REQUEST")"
	require_code "destroy apply create" "$DESTROY_APPLY_RESPONSE" "201"
	DESTROY_APPLY_BODY="$(response_body "$DESTROY_APPLY_RESPONSE")"
	DESTROY_ID="$(printf '%s' "$DESTROY_APPLY_BODY" | json_field "data['applyRun']['id']")"
	DESTROY_STATUS="$(printf '%s' "$DESTROY_APPLY_BODY" | json_field "data['applyRun']['status']")"
	if [[ "$DESTROY_STATUS" == "queued" || "$DESTROY_STATUS" == "running" ]]; then
		DESTROY_APPLY_BODY="$(wait_for_run "$DESTROY_ID" "destroy apply")"
		DESTROY_STATUS="$(printf '%s' "$DESTROY_APPLY_BODY" | json_field "data['run']['status']")"
	fi
	if [[ "$DESTROY_STATUS" != "succeeded" ]]; then
		echo "FAIL: destroy apply status=$DESTROY_STATUS (expected succeeded)" >&2
		echo "      response: $DESTROY_APPLY_BODY" >&2
		exit 1
	fi
	DESTROYED_CAPSULE_RESPONSE="$(get_json "/internal/v1/capsules/$CAPSULE_ID")"
	require_code "get destroyed capsule" "$DESTROYED_CAPSULE_RESPONSE" "200"
	DESTROYED_CAPSULE_STATUS="$(response_body "$DESTROYED_CAPSULE_RESPONSE" | json_field "data['capsule']['status']")"
	if [[ "$DESTROYED_CAPSULE_STATUS" != "destroyed" ]]; then
		echo "FAIL: capsule status=$DESTROYED_CAPSULE_STATUS after destroy apply" >&2
		exit 1
	fi
fi

echo "OK git capsule run workspace=$WORKSPACE_ID source=$SOURCE_ID sync=$SYNC_ID capsule=$CAPSULE_ID plan=$PLAN_ID apply=$APPLY_ID destroy=$DESTROY_ID stateVersions=$STATE_VERSION_COUNT snapshots=$SNAPSHOT_COUNT profiles=$PROFILE_IDS outputs=$OUTPUT_SUMMARY"
