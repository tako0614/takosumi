#!/usr/bin/env bash
# Deploy the Takos product through the local Takosumi Installer API and verify
# the public gateway health endpoint.
#
# Prereq:
#   bash scripts/up.sh --profile postgres
#
# Run:
#   bash scripts/takos-deploy-smoke.sh
#   bash scripts/takos-deploy-smoke.sh --build-images
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ECOSYSTEM_ROOT="$(cd "$SUBSTRATE_DIR/../../.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"

TOKEN="${TAKOSUMI_INSTALLER_TOKEN:-local-substrate-installer-token}"
SPACE_ID="${TAKOS_DEPLOY_SMOKE_SPACE_ID:-space_takos_smoke_$(date +%Y%m%d%H%M%S)}"
SOURCE_PATH="${TAKOS_DEPLOY_SMOKE_SOURCE_PATH:-/sources/takos}"
SERVICE_URL="${TAKOSUMI_SERVICE_URL:-https://accounts.takosumi.test}"
GATEWAY_URL="${TAKOS_DEPLOY_SMOKE_GATEWAY_URL:-https://takos.app.takosumi.test}"
GATEWAY_TIMEOUT_SECONDS="${TAKOS_DEPLOY_SMOKE_GATEWAY_TIMEOUT_SECONDS:-480}"
BUILD_IMAGES="${TAKOS_DEPLOY_SMOKE_BUILD_IMAGES:-auto}"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--build-images)
			BUILD_IMAGES="1"
			shift
			;;
		--no-build)
			BUILD_IMAGES="0"
			shift
			;;
		*)
			echo "unknown arg: $1" >&2
			exit 1
			;;
	esac
done

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA - run scripts/up.sh --profile postgres first" >&2
	exit 1
fi

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

build_image() {
	local image="$1"
	shift
	echo "==> Building $image"
	docker build -t "$image" "$@"
}

ensure_image() {
	local image="$1"
	shift
	if [[ "$BUILD_IMAGES" == "1" ]]; then
		build_image "$image" "$@"
		return
	fi
	if docker image inspect "$image" >/dev/null 2>&1; then
		echo "==> Using existing image $image"
		return
	fi
	if [[ "$BUILD_IMAGES" == "0" ]]; then
		echo "Missing image $image; rerun with --build-images or unset --no-build" >&2
		exit 1
	fi
	build_image "$image" "$@"
}

ensure_images() {
	ensure_image ghcr.io/takos/takos-git:latest \
		"$ECOSYSTEM_ROOT/takos/git"
	ensure_image ghcr.io/takos/takos-agent:latest \
		"$ECOSYSTEM_ROOT/takos/agent"
	ensure_image ghcr.io/takos/takos-app:latest \
		-f "$ECOSYSTEM_ROOT/takos/deploy/docker/takos-app.Dockerfile" \
		"$ECOSYSTEM_ROOT/takos"
}

post_json() {
	local path="$1"
	local body="$2"
	curl -skS --max-time 900 --cacert "$CA" \
		--resolve accounts.takosumi.test:443:127.0.0.1 \
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

json_get() {
	local expr="$1"
	python3 -c '
import json
import sys

body = json.load(sys.stdin)
value = eval(sys.argv[1], {"__builtins__": {}}, {"body": body})
if isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(",", ":")))
elif value is None:
    print("")
else:
    print(value)
' "$expr"
}

wait_gateway() {
	local deadline=$((SECONDS + GATEWAY_TIMEOUT_SECONDS))
	local body=""
	while (( SECONDS < deadline )); do
		body="$(curl -skS --max-time 20 --cacert "$CA" \
			--resolve takos.app.takosumi.test:443:127.0.0.1 \
			"$GATEWAY_URL/health" || true)"
		if printf '%s' "$body" | python3 -c '
import json
import sys

try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(1)

checks = body.get("checks") or {}
if (
    body.get("ok") is True
    and body.get("service") == "takos-app"
    and (checks.get("db") or {}).get("ok") is True
    and (checks.get("takosumiAccounts") or {}).get("ok") is True
):
    sys.exit(0)
sys.exit(1)
'; then
			printf '%s\n' "$body"
			return 0
		fi
		sleep 5
	done

	echo "FAIL: gateway did not become healthy within ${GATEWAY_TIMEOUT_SECONDS}s" >&2
	echo "      last response: $body" >&2
	return 1
}

ensure_images

INSTALL_REQUEST="$(cat <<EOF
{
  "spaceId": "$SPACE_ID",
  "source": {
    "kind": "local",
    "url": "$SOURCE_PATH"
  }
}
EOF
)"

echo "==> Installer dry-run for Takos source $SOURCE_PATH"
DRY_RESPONSE="$(post_json "/v1/installations/dry-run" "$INSTALL_REQUEST")"
require_code "Takos installation dry-run" "$DRY_RESPONSE" "200"
DRY_BODY="$(response_body "$DRY_RESPONSE")"
EXPECTED_PIN="$(printf '%s' "$DRY_BODY" | json_get 'body["expected"]')"
PLAN_DIGEST="$(printf '%s' "$DRY_BODY" | json_get 'body.get("planSnapshotDigest", "")')"

APPLY_REQUEST="$(printf '%s' "$INSTALL_REQUEST" | python3 -c '
import json
import sys

body = json.load(sys.stdin)
body["expected"] = json.loads(sys.argv[1])
print(json.dumps(body, separators=(",", ":")))
' "$EXPECTED_PIN")"

echo "==> Applying Takos installation"
APPLY_RESPONSE="$(post_json "/v1/installations" "$APPLY_REQUEST")"
require_code "Takos installation apply" "$APPLY_RESPONSE" "201"
APPLY_BODY="$(response_body "$APPLY_RESPONSE")"
INSTALLATION_ID="$(printf '%s' "$APPLY_BODY" | json_get 'body["installation"]["id"]')"
DEPLOYMENT_ID="$(printf '%s' "$APPLY_BODY" | json_get 'body["deployment"]["id"]')"
DEPLOYMENT_STATUS="$(printf '%s' "$APPLY_BODY" | json_get 'body["deployment"]["status"]')"
PUBLIC_URL="$(printf '%s' "$APPLY_BODY" | json_get '(((body["deployment"].get("outputs") or {}).get("components") or {}).get("public") or {}).get("public", {}).get("url", "")')"

if [[ "$DEPLOYMENT_STATUS" != "succeeded" ]]; then
	echo "FAIL: Takos deployment.status=$DEPLOYMENT_STATUS" >&2
	echo "      response: $APPLY_BODY" >&2
	exit 1
fi

if [[ -n "$PUBLIC_URL" ]]; then
	GATEWAY_URL="$PUBLIC_URL"
fi

echo "==> Waiting for $GATEWAY_URL/health"
HEALTH_BODY="$(wait_gateway)"

echo "OK Takos deployed installation=$INSTALLATION_ID deployment=$DEPLOYMENT_ID digest=$PLAN_DIGEST"
echo "OK gateway $GATEWAY_URL/health -> $HEALTH_BODY"
