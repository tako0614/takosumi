#!/usr/bin/env bash
# Bring up local-substrate.
#
# Without --profile : Phase 0 ingress only (Pebble + CoreDNS + Caddy).
# With --profile postgres : ingress + Deno/Postgres kernel + Accounts + cloud worker.
# With --profile workers  : ingress + Worker kernel + Accounts + cloud worker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SUBSTRATE_DIR"

PROFILE=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--profile)
			PROFILE="$2"
			shift 2
			;;
		--profile=*)
			PROFILE="${1#--profile=}"
			shift
			;;
		*)
			echo "unknown arg: $1" >&2
			exit 1
			;;
	esac
done

case "$PROFILE" in
	""|postgres|workers) ;;
	*)
		echo "--profile must be one of: postgres, workers (got: $PROFILE)" >&2
		exit 1
		;;
esac

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || {
	echo "docker compose plugin is required" >&2; exit 1;
}

wait_for_completed_service() {
	local service=$1
	local id=""
	id=$(docker compose -f compose.substrate.yml --profile "$PROFILE" ps -q "$service" 2>/dev/null || true)
	if [[ -z "$id" ]]; then
		return 0
	fi

	for _ in $(seq 1 120); do
		local status exit_code
		status=$(docker inspect -f '{{.State.Status}}' "$id")
		exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$id")
		case "$status:$exit_code" in
			exited:0)
				return 0
				;;
			exited:*)
				echo "$service exited with code $exit_code" >&2
				docker logs "$id" | tail -80 >&2
				return 1
				;;
		esac
		sleep 1
	done

	echo "$service did not complete within 120s" >&2
	docker logs "$id" | tail -80 >&2
	return 1
}

mkdir -p caddy/runtime

echo "==> Starting Pebble and CoreDNS"
docker compose -f compose.ingress.yml up -d pebble coredns

echo "==> Waiting for Pebble management API to respond"
for _ in $(seq 1 60); do
	if curl -sk https://127.0.0.1:15000/roots/0 >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

if ! curl -sk https://127.0.0.1:15000/roots/0 >/dev/null 2>&1; then
	echo "Pebble did not become ready within 60s" >&2
	docker compose -f compose.ingress.yml logs pebble | tail -50 >&2
	exit 1
fi

echo "==> Extracting Pebble minica (Caddy will use to verify Pebble's ACME directory)"
docker compose -f compose.ingress.yml cp \
	pebble:/test/certs/pebble.minica.pem \
	caddy/runtime/pebble.minica.pem

echo "==> Capturing Pebble issuance root (host will use to verify certs issued by Pebble)"
curl -sk https://127.0.0.1:15000/roots/0 -o caddy/runtime/pebble-issuance-root.pem

echo "==> Starting Caddy"
docker compose -f compose.ingress.yml up -d caddy

if [[ -n "$PROFILE" ]]; then
	echo "==> Starting substrate stack (profile: $PROFILE)"
	docker compose -f compose.substrate.yml --profile "$PROFILE" up -d

	echo "==> Waiting for static build outputs"
	wait_for_completed_service takosumi-website-build
	wait_for_completed_service takosumi-docs-build
	wait_for_completed_service takosumi-cloud-dashboard-build

	# The static builders can replace .output/public after Caddy has already
	# bind-mounted it. Recreate Caddy so it sees the final directories.
	echo "==> Recreating Caddy after static builds"
	docker compose -f compose.ingress.yml up -d --force-recreate caddy

	echo "==> Waiting for substrate services to become healthy"
	for _ in $(seq 1 120); do
		# Check OIDC discovery via Caddy as a proxy for full readiness.
		if curl -sk --cacert caddy/runtime/pebble-issuance-root.pem \
			--resolve accounts.takosumi.test:443:127.0.0.1 \
			https://accounts.takosumi.test/.well-known/openid-configuration \
			>/dev/null 2>&1; then
			break
		fi
		sleep 2
	done
fi

cat <<EOF

==> local-substrate is up (profile: ${PROFILE:-none/ingress-only}).

Next steps (one-time per host):
   sudo bash scripts/ca-install.sh         # trust Pebble issuance root
   sudo bash scripts/configure-dns.sh      # split-DNS for *.takosumi.test

Verify (Phase 0):
   curl https://hello.takosumi.test/

Verify (profile=postgres):
   curl https://accounts.takosumi.test/.well-known/openid-configuration
   curl https://kernel.takosumi.test/health
   curl https://kernel-worker.takosumi.test/healthz

Verify (profile=workers):
   curl https://accounts.takosumi.test/.well-known/openid-configuration
   curl https://kernel.takosumi.test/healthz
   curl https://kernel.takosumi.test/storage/healthz
EOF
