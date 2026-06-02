#!/usr/bin/env bash
# Bring up local-substrate.
#
# Without --profile : Phase 0 ingress only (Pebble + CoreDNS + Caddy).
# With --profile postgres : ingress + Bun/Postgres service + Accounts + cloud worker.
# With --profile workers  : ingress + Worker service + Accounts + cloud worker.
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

# LAN mode 起動: TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP / DNS_HOST_BIND を export
# 済の caller (= dev マシンの shell profile に export 済) はそのまま通す。
# 未設定なら single-machine default (127.0.0.1) で render。
INGRESS_IP="${TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP:-127.0.0.1}"
DNS_HOST_BIND="${TAKOSUMI_LOCAL_SUBSTRATE_DNS_HOST_BIND:-127.0.0.1}"
export TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP="$INGRESS_IP"
export TAKOSUMI_LOCAL_SUBSTRATE_DNS_HOST_BIND="$DNS_HOST_BIND"

echo "==> Rendering CoreDNS zone files (INGRESS_IP=$INGRESS_IP)"
bash "$SCRIPT_DIR/dns-zone-render.sh"

echo "==> Starting Pebble and CoreDNS (DNS host bind=$DNS_HOST_BIND:53)"
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
old_issuance_root_hash=""
if [[ -f caddy/runtime/pebble-issuance-root.pem ]]; then
	old_issuance_root_hash="$(sha256sum caddy/runtime/pebble-issuance-root.pem | awk '{print $1}')"
fi
curl -sk https://127.0.0.1:15000/roots/0 -o caddy/runtime/pebble-issuance-root.pem
new_issuance_root_hash="$(sha256sum caddy/runtime/pebble-issuance-root.pem | awk '{print $1}')"
if [[ "${TAKOSUMI_LOCAL_SUBSTRATE_REFRESH_CADDY_ACME_CACHE:-1}" == "1" ||
	( -n "$old_issuance_root_hash" && "$old_issuance_root_hash" != "$new_issuance_root_hash" ) ]]; then
	echo "==> Refreshing Caddy ACME cache"
	docker compose -f compose.ingress.yml stop caddy >/dev/null 2>&1 || true
	docker compose -f compose.ingress.yml rm -f -s caddy >/dev/null 2>&1 || true
	docker volume rm local-substrate_caddy-data local-substrate_caddy-config >/dev/null 2>&1 || true
fi

echo "==> Starting Caddy"
docker compose -f compose.ingress.yml up -d caddy

if [[ -n "$PROFILE" ]]; then
	echo "==> Starting substrate stack (profile: $PROFILE)"
	docker compose -f compose.substrate.yml --profile "$PROFILE" up -d

	echo "==> Waiting for static build outputs"
	wait_for_completed_service takosumi-website-build
	wait_for_completed_service takosumi-docs-build
	wait_for_completed_service takosumi-dashboard-build

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
==> INGRESS_IP=$INGRESS_IP, DNS_HOST_BIND=$DNS_HOST_BIND

Next steps (one-time per host):
   sudo bash scripts/ca-install.sh         # trust Pebble issuance root
   sudo bash scripts/configure-dns.sh      # split-DNS for *.takosumi.test
                                           # LAN mode: pass --dns <dev-LAN-IP>

LAN mode (LAN client browser からアクセスする):
   docs/lan-host.md を参照。 LAN client は別途 ca-install.sh と
   configure-dns.sh --dns <dev-LAN-IP> 相当の手順が必要。

Verify (Phase 0):
   curl https://hello.takosumi.test/

Verify (profile=postgres):
   curl https://accounts.takosumi.test/.well-known/openid-configuration
   curl https://accounts.takosumi.test/healthz
   curl https://cloud-worker.takosumi.test/.well-known/openid-configuration
   curl https://service-worker.takosumi.test/healthz

Verify (profile=workers):
   curl https://accounts.takosumi.test/.well-known/openid-configuration
   curl https://service.takosumi.test/healthz
   curl https://service.takosumi.test/storage/healthz
EOF
