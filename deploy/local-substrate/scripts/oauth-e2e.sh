#!/usr/bin/env bash
# Walks the full upstream OAuth flow end-to-end against the local oauth-mock:
#
#   1. Worker /v1/auth/upstream/authorize  -> 302 to oauth-mock /authorize
#   2. Mock /authorize                     -> 302 to /sign-in/callback with code
#   3. Worker /v1/auth/upstream/callback   -> 200 with {subject, ...}
#      and an HttpOnly takosumi_session cookie.
#   4. Worker /v1/account/session/me       -> 200 with the same subject via cookie.
#
# Run as: bash scripts/oauth-e2e.sh [google]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"
PROVIDER="${1:-google}"
APP_HOST="${TAKOSUMI_LOCAL_APP_HOST:-app.takosumi.test}"
OAUTH_HOST="${TAKOSUMI_LOCAL_OAUTH_MOCK_HOST:-oauth-mock.test}"
BASE="https://${APP_HOST}"
STATE="oauth_e2e_$(date +%s%N)_$$"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT
CURL_TLS=(--cacert "$CA" --resolve "${APP_HOST}:443:127.0.0.1" --resolve "${OAUTH_HOST}:443:127.0.0.1")

if [[ ! -f "$CA" ]]; then
	echo "Pebble CA not found at $CA — run scripts/up.sh first" >&2
	exit 1
fi
if [[ "$PROVIDER" != "google" ]]; then
	echo "Unsupported local OAuth provider '$PROVIDER'; Takosumi sign-in is Google-only." >&2
	exit 2
fi

# 1. /v1/auth/upstream/authorize → 302 to mock /authorize
LOC1=$(curl -sk --cacert "$CA" -o /dev/null -w "%{redirect_url}" \
	"${CURL_TLS[@]}" \
	-c "$COOKIE_JAR" -b "$COOKIE_JAR" \
	"${BASE}/v1/auth/upstream/authorize?provider=${PROVIDER}&state=${STATE}")
[[ -n "$LOC1" ]] || { echo "FAIL: worker /authorize returned no redirect" >&2; exit 1; }

# 2. Follow mock /authorize → 302 to /sign-in/callback with code
LOC2=$(curl -sk --cacert "$CA" -o /dev/null -w "%{redirect_url}" \
	"${CURL_TLS[@]}" \
	-c "$COOKIE_JAR" -b "$COOKIE_JAR" "$LOC1")
CODE=$(echo "$LOC2" | sed -nE 's/.*[?&]code=([^&]*).*/\1/p')
CALLBACK_STATE=$(echo "$LOC2" | sed -nE 's/.*[?&]state=([^&]*).*/\1/p')
[[ -n "$CODE" ]] || { echo "FAIL: mock /authorize did not return a code (got: $LOC2)" >&2; exit 1; }
[[ -n "$CALLBACK_STATE" ]] || { echo "FAIL: mock /authorize did not return state (got: $LOC2)" >&2; exit 1; }

# 3. /v1/auth/upstream/callback with code+state+provider -> 200 with subject
RESP=$(curl -sk --cacert "$CA" \
	"${CURL_TLS[@]}" \
	-c "$COOKIE_JAR" -b "$COOKIE_JAR" \
	"${BASE}/v1/auth/upstream/callback?provider=${PROVIDER}&code=${CODE}&state=${CALLBACK_STATE}")
SUBJECT=$(echo "$RESP" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(d.get('subject') or '')")
SESSION_ID_IN_BODY=$(echo "$RESP" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(d.get('session_id') or '')")
if [[ -z "$SUBJECT" ]]; then
	echo "FAIL: callback did not return subject (got: $RESP)" >&2
	exit 1
fi
if [[ -n "$SESSION_ID_IN_BODY" ]]; then
	echo "FAIL: callback leaked session_id in JSON body" >&2
	exit 1
fi

# 4. Browser-visible session mirror must resolve the HttpOnly cookie without
# exposing the raw session id to script callers.
ME=$(curl -sk --cacert "$CA" \
	"${CURL_TLS[@]}" \
	-b "$COOKIE_JAR" \
	"${BASE}/v1/account/session/me")
ME_SUBJECT=$(echo "$ME" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(d.get('subject') or '')")
if [[ "$ME_SUBJECT" != "$SUBJECT" ]]; then
	echo "FAIL: session/me subject mismatch (callback=$SUBJECT me=$ME)" >&2
	exit 1
fi

echo "OK [$PROVIDER] subject=$SUBJECT cookie session verified"
