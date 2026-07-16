#!/usr/bin/env bash
# OpenTelemetry pipeline smoke — proves the collector + Jaeger pair is
# alive and the wire (OTLP → collector → Jaeger) is reachable end-to-end.
#
# Sends a synthetic trace via otel-collector's OTLP/HTTP receiver, polls
# Jaeger's /api/services for the span's service name to land.
#
# No application is instrumented yet — when accounts-service / service /
# service start exporting OTLP they'll appear in the same Jaeger UI
# without further plumbing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CA="$SUBSTRATE_DIR/caddy/runtime/pebble-issuance-root.pem"

# 1. Jaeger UI reachable through Caddy.
CODE=$(curl -sk --cacert "$CA" --resolve "jaeger.takosumi.test:443:127.0.0.1" \
	-o /dev/null -w "%{http_code}" https://jaeger.takosumi.test/)
[[ "$CODE" == "200" ]] || { echo "FAIL: jaeger UI not reachable ($CODE)" >&2; exit 1; }

# 2. Generate a synthetic OTLP/HTTP trace with deterministic IDs.
SVC="local-substrate-otel-smoke-$(date +%s)"
TRACE_ID=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
SPAN_ID=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
NOW_NS=$(python3 -c 'import time; print(int(time.time()*1_000_000_000))')
END_NS=$(python3 -c "print($NOW_NS + 1000000)")

# OTLP/HTTP JSON payload (otelproto.opentelemetry.io v1.proto.trace).
PAYLOAD=$(python3 <<PY
import json, sys
print(json.dumps({
    "resourceSpans": [{
        "resource": {
            "attributes": [
                {"key": "service.name", "value": {"stringValue": "$SVC"}},
            ],
        },
        "scopeSpans": [{
            "scope": {"name": "local-substrate-smoke"},
            "spans": [{
                "traceId": "$TRACE_ID",
                "spanId": "$SPAN_ID",
                "name": "smoke-probe",
                "kind": 1,
                "startTimeUnixNano": $NOW_NS,
                "endTimeUnixNano": $END_NS,
            }],
        }],
    }],
}))
PY
)

# Post directly to the collector through its host-loopback OTLP/HTTP port
# (skips Caddy; not exposed on a public interface).
curl -sS --max-time 10 -X POST \
	-H "Content-Type: application/json" \
	-d "$PAYLOAD" \
	"http://127.0.0.1:14318/v1/traces" >/dev/null

# 3. Poll Jaeger /api/services for the new service name (Jaeger ingests
#    asynchronously; give it a few seconds).
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if curl -sk --cacert "$CA" --resolve "jaeger.takosumi.test:443:127.0.0.1" \
		"https://jaeger.takosumi.test/api/services" \
			| python3 -c "import json, sys; d=json.load(sys.stdin); sys.exit(0 if '$SVC' in (d.get('data') or []) else 1)" 2>/dev/null; then
		echo "OK otel collector → jaeger pipeline alive (service=$SVC)"
		exit 0
	fi
	sleep 1
done

echo "FAIL: service $SVC did not show up in Jaeger after 10s" >&2
exit 1
