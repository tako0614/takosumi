#!/usr/bin/env bash
# Multi-tenant isolation smoke: user A must not be readable by user B.
#
# Walks:
#   1. Mint subject A through the Google oauth-mock dance.
#   2. Use the local-substrate dev fixture session as subject B.
#   3. POST an installation as A with A's HttpOnly cookie.
#   4. GET that installation with B's bearer -> MUST be non-200.
#   5. GET with A's cookie -> 200 (sanity).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
BASE="https://app.takosumi.test"
LOCAL_DEV_SESSION_ID="${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID:-sess_local_substrate}"
LOCAL_DEV_SUBJECT="${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT:-tsub_takosumi_accounts_local}"
COOKIE_JARS=()

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
	loc1=$(curl -sk --cacert "$CA" -o /dev/null -w "%{redirect_url}" \
		-c "$jar" -b "$jar" \
		"$BASE/v1/auth/upstream/authorize?provider=google&state=$state")
	local loc2
	loc2=$(curl -sk --cacert "$CA" -o /dev/null -w "%{redirect_url}" \
		-c "$jar" -b "$jar" "$loc1")
	local code
	code=$(echo "$loc2" | sed -nE 's/.*[?&]code=([^&]*).*/\1/p')
	[[ -n "$code" ]] || {
		echo "FAIL: mock authorize did not return code" >&2
		exit 1
	}
	local resp
	resp=$(curl -sk --cacert "$CA" \
		-c "$jar" -b "$jar" \
		"$BASE/v1/auth/upstream/callback?provider=google&code=$code&state=$state")
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
	me=$(curl -sk --cacert "$CA" -b "$jar" "$BASE/v1/account/session/me")
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

DEV_ME=$(curl -sk --cacert "$CA" \
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

APP_ID="takos-docs"
COMMIT="0000000000000000000000000000000000000000"
DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"
RUN_SUFFIX="$(date +%s%N)_$RANDOM"

INSTALL_PAYLOAD=$(cat <<JSON
{
  "accountId": "acct_iso_${RUN_SUFFIX}",
  "spaceId": "space_iso_${RUN_SUFFIX}",
  "appId": "$APP_ID",
  "source": {
    "gitUrl": "https://github.com/tako0614/takos-docs.git",
    "ref": "main",
    "commit": "$COMMIT",
    "planDigest": "$DIGEST"
  },
  "mode": "shared-cell",
  "createdBySubject": "$SUB_A"
}
JSON
)
CREATE_RESP=$(curl -sk --cacert "$CA" -X POST \
	-b "$JAR_A" \
	-H "Content-Type: application/json" \
	-d "$INSTALL_PAYLOAD" \
	"$BASE/v1/installation-projections")
INST_ID=$(echo "$CREATE_RESP" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print((d.get('installation') or {}).get('id', ''))
")
if [[ -z "$INST_ID" ]]; then
	echo "FAIL: subject A could not create installation: $CREATE_RESP" >&2
	exit 1
fi

cleanup() {
	curl -sk --cacert "$CA" -X DELETE \
		-b "$JAR_A" \
		"$BASE/v1/installation-projections/$INST_ID" >/dev/null 2>&1 || true
	cleanup_jars
}
trap cleanup EXIT

STATUS_A=$(curl -sk --cacert "$CA" -o /dev/null -w "%{http_code}" \
	-b "$JAR_A" \
	"$BASE/v1/installation-projections/$INST_ID")
if [[ "$STATUS_A" != "200" ]]; then
	echo "FAIL: subject A can't read own installation: $STATUS_A" >&2
	exit 1
fi

STATUS_B=$(curl -sk --cacert "$CA" -o /dev/null -w "%{http_code}" \
	-H "Authorization: Bearer $LOCAL_DEV_SESSION_ID" \
	"$BASE/v1/installation-projections/$INST_ID")

if [[ "$STATUS_B" == "200" ]]; then
	echo "FAIL: TENANT ISOLATION VIOLATION - subject B read subject A's installation" >&2
	echo "      A=$SUB_A  B=$SUB_B  installation=$INST_ID" >&2
	exit 1
fi

echo "OK tenant isolation enforced - A=$SUB_A own=200 B=$SUB_B cross-read=$STATUS_B"
