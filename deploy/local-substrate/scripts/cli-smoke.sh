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
source "$SCRIPT_DIR/compose-helpers.sh"
PROFILE="$(local_substrate_profile)"
case "$PROFILE" in
	workers) DEFAULT_SERVICE_URL="https://service.takosumi.test" ;;
	postgres) DEFAULT_SERVICE_URL="https://app.takosumi.test" ;;
esac
SERVICE_URL="${TAKOSUMI_SERVICE_URL:-$DEFAULT_SERVICE_URL}"
CURL_RESOLVE=()
if [[ "$SERVICE_URL" =~ ^https://([a-z0-9.-]+\.takosumi\.test)(/|$) ]]; then
	CURL_RESOLVE=(--resolve "${BASH_REMATCH[1]}:443:127.0.0.1")
fi
RUN_SUFFIX="$(date +%s%N)"
APP_NAME="cli-smoke-$RUN_SUFFIX"

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA — run scripts/up.sh first" >&2
	exit 1
fi

# Progress markers. cli-smoke drives a real Git clone + tofu plan/apply
# through the runner, so when it is killed for exceeding its bound the log
# has to say which step was still in flight.
step() {
	# stderr: wait_for_run's stdout is the captured Run JSON.
	echo "--> $*" >&2
}

# No request may hang. An unbounded curl here has cost this smoke entire CI
# jobs, and a stalled control-plane call is a failure worth reporting, not
# worth waiting on.
CURL_BOUNDS=(--connect-timeout 10 --max-time 60)

# `set -e` would abort on a curl that never completes without saying anything,
# so name the transport failure instead of dying silently mid-step.
report_curl_failure() {
	echo "FAIL: $1 $2 did not complete (curl exit $3; bounds ${CURL_BOUNDS[*]})" >&2
	exit 1
}

post_json() {
	local path="$1"
	local body="$2"
	local out exit_code=0
	out="$(curl -sk --cacert "$CA" \
		"${CURL_RESOLVE[@]}" "${CURL_BOUNDS[@]}" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-d "$body" \
		-w "\n%{http_code}\n" \
		"$SERVICE_URL$path")" || exit_code=$?
	[[ "$exit_code" -eq 0 ]] || report_curl_failure POST "$path" "$exit_code"
	printf '%s' "$out"
}

get_json() {
	local path="$1"
	local out exit_code=0
	out="$(curl -sk --cacert "$CA" \
		"${CURL_RESOLVE[@]}" "${CURL_BOUNDS[@]}" \
		-H "Authorization: Bearer $TOKEN" \
		-H "Content-Type: application/json" \
		-w "\n%{http_code}\n" \
		"$SERVICE_URL$path")" || exit_code=$?
	[[ "$exit_code" -eq 0 ]] || report_curl_failure GET "$path" "$exit_code"
	printf '%s' "$out"
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
	local response status last_status=""
	for _ in $(seq 1 120); do
		response="$(get_json "/internal/v1/runs/$run_id")"
		require_code "read $label run" "$response" "200"
		status="$(response_body "$response" | json_field "data['run']['status']")"
		if [[ "$status" != "$last_status" ]]; then
			step "waiting on $label run $run_id: $status"
			last_status="$status"
		fi
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

# Reachability first, with the timing breakdown. When this host stops
# answering, the breakdown says whether it died at TCP connect, at the TLS
# handshake, or waiting for a first byte — three very different faults that a
# bare "it hung" cannot tell apart.
step "0. probe $SERVICE_URL"
probe_exit=0
probe="$(curl -sk --cacert "$CA" "${CURL_RESOLVE[@]}" \
	--connect-timeout 5 --max-time 20 -o /dev/null \
	-w 'http=%{http_code} connect=%{time_connect}s tls=%{time_appconnect}s firstbyte=%{time_starttransfer}s total=%{time_total}s' \
	"$SERVICE_URL/healthz")" || probe_exit=$?
step "   $probe curl_exit=$probe_exit"
if [[ "$probe_exit" -ne 0 ]]; then
	echo "FAIL: $SERVICE_URL is not reachable from the host ($probe curl_exit=$probe_exit)" >&2
	exit 1
fi

step "1. runner profiles"
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
step "2. create workspace"
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
step "3. create source $SOURCE_GIT@$SOURCE_REF"
SOURCE_RESPONSE="$(post_json "/internal/v1/sources" "$SOURCE_REQUEST")"
require_code "source create" "$SOURCE_RESPONSE" "201"
SOURCE_ID="$(response_body "$SOURCE_RESPONSE" | json_field "data['source']['id']")"

step "4. sync source $SOURCE_ID"
SYNC_RESPONSE="$(post_json "/internal/v1/sources/$SOURCE_ID/sync" '{}')"
require_code "source sync create" "$SYNC_RESPONSE" "201"
SYNC_ID="$(response_body "$SYNC_RESPONSE" | json_field "data['run']['id']")"
wait_for_run "$SYNC_ID" "source sync" >/dev/null
step "5. read snapshots"
SNAPSHOTS_RESPONSE="$(get_json "/internal/v1/sources/$SOURCE_ID/snapshots")"
require_code "source snapshots" "$SNAPSHOTS_RESPONSE" "200"
SNAPSHOT_COUNT="$(response_body "$SNAPSHOTS_RESPONSE" | json_field "len(data.get('snapshots') or [])")"
[[ "$SNAPSHOT_COUNT" -gt 0 ]] || {
	echo "FAIL: source sync recorded no snapshots for $SOURCE_ID" >&2
	echo "      response: $(response_body "$SNAPSHOTS_RESPONSE")" >&2
	exit 1
}

CAPSULE_REQUEST=$(cat <<EOF
{
  "name": "$APP_NAME",
  "environment": "preview",
  "sourceId": "$SOURCE_ID",
  "installConfigId": "$INSTALL_CONFIG_ID",
  "runnerId": "opentofu-default",
  "vars": {
    "base_domain": "$APP_NAME.takosumi.test",
    "display_name": "CLI smoke"
  }
}
EOF
)
step "6. create capsule"
CAPSULE_RESPONSE="$(post_json "/internal/v1/workspaces/$WORKSPACE_ID/capsules" "$CAPSULE_REQUEST")"
require_code "capsule create" "$CAPSULE_RESPONSE" "201"
CAPSULE_ID="$(response_body "$CAPSULE_RESPONSE" | json_field "data['capsule']['id']")"

step "7. plan capsule $CAPSULE_ID"
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
step "8. apply run"
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

step "9. read capsule + state versions"
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

echo "OK git capsule run workspace=$WORKSPACE_ID source=$SOURCE_ID sync=$SYNC_ID capsule=$CAPSULE_ID plan=$PLAN_ID apply=$APPLY_ID stateVersions=$STATE_VERSION_COUNT snapshots=$SNAPSHOT_COUNT profiles=$PROFILE_IDS"
