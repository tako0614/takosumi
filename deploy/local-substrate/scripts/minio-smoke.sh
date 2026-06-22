#!/usr/bin/env bash
# Object round-trip against the local MinIO (R2-compatible) to make sure
# the service's object-store provider has a working backend.
#
# Uses minio/mc inside the substrate docker network. Writes a deterministic
# blob, reads it back, asserts sha256 matches, then cleans up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/compose-helpers.sh"

NETWORK="local-substrate_takos-local-internal"
USER="${MINIO_ROOT_USER:-takos}"
PASS="${MINIO_ROOT_PASSWORD:-takos-minio-pw}"
MC_TIMEOUT="${MINIO_MC_TIMEOUT:-30s}"
BUCKET="smoke-$(date +%s)"
PAYLOAD="hello takos minio $(date -u +%FT%TZ) $RANDOM"
EXPECTED=$(echo -n "$PAYLOAD" | sha256sum | head -c 64)

mc() {
	local_substrate_timeout_docker_run "$MC_TIMEOUT" --rm \
		--network "$NETWORK" \
		-e MC_HOST_takos="http://${USER}:${PASS}@minio:9000" \
		minio/mc:latest "$@"
}

# 1. Create bucket
mc mb -q takos/"$BUCKET" >/dev/null

# 2. Put blob
echo -n "$PAYLOAD" | local_substrate_timeout_docker_run "$MC_TIMEOUT" --rm -i \
	--network "$NETWORK" \
	-e MC_HOST_takos="http://${USER}:${PASS}@minio:9000" \
	minio/mc:latest pipe takos/"$BUCKET"/blob >/dev/null

# 3. Get blob + compute sha256
ACTUAL=$(mc cat takos/"$BUCKET"/blob | sha256sum | head -c 64)

# 4. Clean up
mc rm --force --recursive takos/"$BUCKET"/ >/dev/null 2>&1 || true
mc rb takos/"$BUCKET" >/dev/null 2>&1 || true

if [[ "$ACTUAL" != "$EXPECTED" ]]; then
	echo "FAIL: sha256 mismatch (got $ACTUAL, expected $EXPECTED)" >&2
	exit 1
fi

echo "OK minio round-trip bucket=$BUCKET sha256=${EXPECTED:0:16}..."
