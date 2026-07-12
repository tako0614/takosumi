#!/usr/bin/env bash
# Multi-tenant isolation smoke: user A must not be readable by user B.
#
# Walks:
#   1. Mint subject A through the Google oauth-mock dance.
#   2. Use the local-substrate dev fixture session as subject B.
#   3. Create a Workspace, Git Source, and Capsule as A with A's HttpOnly cookie.
#   4. Read that Capsule as B with the local fixture bearer -> MUST be non-200.
#   5. Read/list with A's cookie -> 200 (sanity).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
APP_HOST="${TAKOSUMI_LOCAL_APP_HOST:-app.takosumi.test}"
OAUTH_HOST="${TAKOSUMI_LOCAL_OAUTH_MOCK_HOST:-oauth-mock.test}"
BASE="https://${APP_HOST}"
LOCAL_DEV_SESSION_ID="${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID:-sess_local_substrate}"
LOCAL_DEV_SUBJECT="${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT:-tsub_takosumi_accounts_local}"
COOKIE_JARS=()
CURL_TLS=(--cacert "$CA" --resolve "${APP_HOST}:443:127.0.0.1" --resolve "${OAUTH_HOST}:443:127.0.0.1")

cleanup_jars() {
	for jar in "${COOKIE_JARS[@]}"; do
		rm -f "$jar"
	done
}
trap cleanup_jars EXIT

mint_google_cookie_session() {
	local state="tenant_iso_$(date +%s%N)_$$_$RANDOM"
	local jar
	jar="$(mktemp)"
	COOKIE_JARS+=("$jar")
	local loc1
	loc1=$(curl -sk "${CURL_TLS[@]}" -o /dev/null -w "%{redirect_url}" \
		-c "$jar" -b "$jar" \
		"$BASE/v1/auth/upstream/authorize?provider=google&state=$state")
	local loc2
	loc2=$(curl -sk "${CURL_TLS[@]}" -o /dev/null -w "%{redirect_url}" \
		-c "$jar" -b "$jar" "$loc1")
	local code
	code=$(echo "$loc2" | sed -nE 's/.*[?&]code=([^&]*).*/\1/p')
	[[ -n "$code" ]] || {
		echo "FAIL: mock authorize did not return code" >&2
		exit 1
	}
	local callback_state
	callback_state=$(echo "$loc2" | sed -nE 's/.*[?&]state=([^&]*).*/\1/p')
	[[ -n "$callback_state" ]] || {
		echo "FAIL: mock authorize did not return state" >&2
		exit 1
	}
	local resp
	resp=$(curl -sk "${CURL_TLS[@]}" \
		-c "$jar" -b "$jar" \
		"$BASE/v1/auth/upstream/callback?provider=google&code=$code&state=$callback_state")
	local subject
	subject=$(echo "$resp" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('subject', ''))
")
	if [[ -z "$subject" ]]; then
		echo "FAIL: Google OAuth callback did not return subject: $resp" >&2
		exit 1
	fi
	local me
	me=$(curl -sk "${CURL_TLS[@]}" -b "$jar" "$BASE/v1/account/session/me")
	local me_subject
	me_subject=$(echo "$me" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('subject', ''))
")
	if [[ "$me_subject" != "$subject" ]]; then
		echo "FAIL: Google cookie session did not resolve through session/me: $me" >&2
		exit 1
	fi
	printf '%s %s\n' "$subject" "$jar"
}

read -r SUB_A JAR_A <<<"$(mint_google_cookie_session)"
[[ -n "$SUB_A" && -n "$JAR_A" ]] || {
	echo "FAIL: subject A creation" >&2
	exit 1
}

DEV_ME=$(curl -sk "${CURL_TLS[@]}" \
	-H "Authorization: Bearer $LOCAL_DEV_SESSION_ID" \
	"$BASE/v1/account/session/me")
SUB_B=$(echo "$DEV_ME" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('subject', ''))
")
if [[ "$SUB_B" != "$LOCAL_DEV_SUBJECT" ]]; then
	echo "FAIL: local dev fixture session did not resolve to $LOCAL_DEV_SUBJECT (got: $DEV_ME)" >&2
	exit 1
fi

if [[ "$SUB_A" == "$SUB_B" ]]; then
	echo "FAIL: subjects A and B collapsed to the same takosumi subject ($SUB_A)" >&2
	exit 1
fi

RUN_SUFFIX="$(date +%s%N)-$RANDOM"
SOURCE_URL="https://github.com/tako0614/takosumi.git"
SOURCE_REF="main"
SOURCE_PATH="opentofu-modules/core/module"
INSTALL_CONFIG_ID="${TAKOSUMI_DEPLOY_CONTROL_INSTALL_CONFIG_ID:-cfg-default-opentofu-capsule}"
WORKSPACE_HANDLE="tenant-iso-${RUN_SUFFIX}"
CAPSULE_NAME="tenant-capsule-${RUN_SUFFIX}"

WORKSPACE_RESP=$(curl -sk "${CURL_TLS[@]}" -X POST \
	-b "$JAR_A" \
	-H "Content-Type: application/json" \
	-d "$(cat <<JSON
{
  "handle": "$WORKSPACE_HANDLE",
  "displayName": "Tenant isolation smoke $RUN_SUFFIX",
  "type": "personal"
}
JSON
)" \
	-w "\n%{http_code}" \
	"$BASE/api/v1/workspaces")
WORKSPACE_STATUS=$(echo "$WORKSPACE_RESP" | tail -n1)
WORKSPACE_BODY=$(echo "$WORKSPACE_RESP" | head -n -1)
if [[ "$WORKSPACE_STATUS" != "201" ]]; then
	echo "FAIL: subject A could not create Workspace: status=$WORKSPACE_STATUS body=$WORKSPACE_BODY" >&2
	exit 1
fi
WORKSPACE_ID=$(echo "$WORKSPACE_BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print((d.get('space') or {}).get('id', ''))
")
if [[ -z "$WORKSPACE_ID" ]]; then
	echo "FAIL: Workspace create response did not include space.id: $WORKSPACE_BODY" >&2
	exit 1
fi

SOURCE_RESP=$(curl -sk "${CURL_TLS[@]}" -X POST \
	-b "$JAR_A" \
	-H "Content-Type: application/json" \
	-d "$(cat <<JSON
{
  "workspaceId": "$WORKSPACE_ID",
  "name": "tenant-source-$RUN_SUFFIX",
  "url": "$SOURCE_URL",
  "defaultRef": "$SOURCE_REF",
  "defaultPath": "$SOURCE_PATH",
  "autoSync": false
}
JSON
)" \
	-w "\n%{http_code}" \
	"$BASE/api/v1/sources")
SOURCE_STATUS=$(echo "$SOURCE_RESP" | tail -n1)
SOURCE_BODY=$(echo "$SOURCE_RESP" | head -n -1)
if [[ "$SOURCE_STATUS" != "201" ]]; then
	echo "FAIL: subject A could not create Source: status=$SOURCE_STATUS body=$SOURCE_BODY" >&2
	exit 1
fi
SOURCE_ID=$(echo "$SOURCE_BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print((d.get('source') or {}).get('id', ''))
")
if [[ -z "$SOURCE_ID" ]]; then
	echo "FAIL: Source create response did not include source.id: $SOURCE_BODY" >&2
	exit 1
fi

CAPSULE_RESP=$(curl -sk "${CURL_TLS[@]}" -X POST \
	-b "$JAR_A" \
	-H "Content-Type: application/json" \
	-d "$(cat <<JSON
{
  "name": "$CAPSULE_NAME",
  "environment": "test",
  "sourceId": "$SOURCE_ID",
  "installConfigId": "$INSTALL_CONFIG_ID",
  "modulePath": "$SOURCE_PATH",
  "runnerProfileId": "opentofu-default"
}
JSON
)" \
	-w "\n%{http_code}" \
	"$BASE/api/v1/workspaces/$WORKSPACE_ID/capsules")
CAPSULE_STATUS=$(echo "$CAPSULE_RESP" | tail -n1)
CAPSULE_BODY=$(echo "$CAPSULE_RESP" | head -n -1)
if [[ "$CAPSULE_STATUS" != "201" ]]; then
	echo "FAIL: subject A could not create Capsule: status=$CAPSULE_STATUS body=$CAPSULE_BODY" >&2
	exit 1
fi
CAPSULE_ID=$(echo "$CAPSULE_BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print((d.get('capsule') or {}).get('id', ''))
")
if [[ -z "$CAPSULE_ID" ]]; then
	echo "FAIL: Capsule create response did not include capsule.id: $CAPSULE_BODY" >&2
	exit 1
fi

cleanup() {
	curl -sk "${CURL_TLS[@]}" -X DELETE \
		-b "$JAR_A" \
		"$BASE/api/v1/capsules/$CAPSULE_ID" >/dev/null 2>&1 || true
	cleanup_jars
}
trap cleanup EXIT

STATUS_A=$(curl -sk "${CURL_TLS[@]}" -o /dev/null -w "%{http_code}" \
	-b "$JAR_A" \
	"$BASE/api/v1/capsules/$CAPSULE_ID")
if [[ "$STATUS_A" != "200" ]]; then
	echo "FAIL: subject A can't read own Capsule: $STATUS_A" >&2
	exit 1
fi

LIST_A=$(curl -sk "${CURL_TLS[@]}" -o /dev/null -w "%{http_code}" \
	-b "$JAR_A" \
	"$BASE/api/v1/workspaces/$WORKSPACE_ID/capsules")
if [[ "$LIST_A" != "200" ]]; then
	echo "FAIL: subject A can't list own Workspace Capsules: $LIST_A" >&2
	exit 1
fi

STATUS_B=$(curl -sk "${CURL_TLS[@]}" -o /dev/null -w "%{http_code}" \
	-H "Authorization: Bearer $LOCAL_DEV_SESSION_ID" \
	"$BASE/api/v1/capsules/$CAPSULE_ID")

if [[ "$STATUS_B" == "200" ]]; then
	echo "FAIL: TENANT ISOLATION VIOLATION - subject B read subject A's Capsule" >&2
	echo "      A=$SUB_A  B=$SUB_B  workspace=$WORKSPACE_ID capsule=$CAPSULE_ID" >&2
	exit 1
fi

LIST_B=$(curl -sk "${CURL_TLS[@]}" -o /dev/null -w "%{http_code}" \
	-H "Authorization: Bearer $LOCAL_DEV_SESSION_ID" \
	"$BASE/api/v1/workspaces/$WORKSPACE_ID/capsules")

if [[ "$LIST_B" == "200" ]]; then
	echo "FAIL: TENANT ISOLATION VIOLATION - subject B listed subject A's Workspace Capsules" >&2
	echo "      A=$SUB_A  B=$SUB_B  workspace=$WORKSPACE_ID" >&2
	exit 1
fi

echo "OK tenant isolation enforced - A=$SUB_A own=200/list=200 B=$SUB_B cross-read=$STATUS_B cross-list=$LIST_B"
