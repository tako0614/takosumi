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
source "$SCRIPT_DIR/compose-helpers.sh"

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
	echo "docker compose implementation is required" >&2; exit 1;
}

wait_for_completed_service() {
	local service=$1
	local id=""
	id=$(compose_substrate --profile "$PROFILE" ps -q "$service" 2>/dev/null || true)
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

prepare_app_armor_substrate_prereqs() {
	if ! local_substrate_disable_apparmor || [[ -z "$PROFILE" ]]; then
		return 0
	fi

	echo "==> Preparing substrate storage outside compose healthchecks (AppArmor override)"
	compose_substrate --profile "$PROFILE" up -d substrate-postgres substrate-minio

	docker run --rm \
		--security-opt apparmor=unconfined \
		--network local-substrate_takos-local-internal \
		-e PGPASSWORD=takos \
		postgres:16-alpine \
		sh -c '
			until pg_isready -h postgres -U takos -d postgres; do sleep 1; done
			for db in takosumi_app takosumi takosumi_accounts; do
				psql -h postgres -U takos -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='\''$db'\''" \
					| grep -q 1 \
					|| psql -h postgres -U takos -d postgres -c "CREATE DATABASE $db"
			done
		'

	docker run --rm \
		--security-opt apparmor=unconfined \
		--network local-substrate_takos-local-internal \
		-e MINIO_ROOT_USER="${MINIO_ROOT_USER:-takos}" \
		-e MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-takos-minio-pw}" \
		--entrypoint /bin/sh \
		minio/mc:latest \
		-c '
			until mc alias set takos http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do sleep 1; done
			mc mb --ignore-existing takos/takosumi
		'

	local repo_root
	repo_root="$(cd "$SUBSTRATE_DIR/../../.." && pwd)"
	local accounts_database_url="postgres://takos:takos@postgres:5432/takosumi_accounts"
	docker run --rm \
		--security-opt apparmor=unconfined \
		--network local-substrate_takos-local-internal \
		--env-file env/cloud.env \
		-v "$repo_root/takosumi:/workspace" \
		-w /workspace \
		-e DATABASE_URL="$accounts_database_url" \
		-e TAKOSUMI_ACCOUNTS_DATABASE_URL="$accounts_database_url" \
		oven/bun:1 \
		sh -c '
			set -e
			bun core/scripts/db-migrate.ts --env=production
			bun cli/src/main.ts accounts migrate \
				--database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
			bun deploy/local-substrate/scripts/seed-dev-session.ts
		'
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
compose_ingress up -d pebble coredns

echo "==> Waiting for Pebble management API to respond"
for _ in $(seq 1 60); do
	if curl -sk https://127.0.0.1:15000/roots/0 >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

if ! curl -sk https://127.0.0.1:15000/roots/0 >/dev/null 2>&1; then
	echo "Pebble did not become ready within 60s" >&2
	compose_ingress logs pebble | tail -50 >&2
	exit 1
fi

echo "==> Extracting Pebble minica (Caddy will use to verify Pebble's ACME directory)"
compose_ingress cp \
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
	compose_ingress stop caddy >/dev/null 2>&1 || true
	compose_ingress rm -f -s caddy >/dev/null 2>&1 || true
	docker volume rm local-substrate_caddy-data local-substrate_caddy-config >/dev/null 2>&1 || true
fi

echo "==> Starting Caddy"
compose_ingress up -d caddy

if [[ -n "$PROFILE" ]]; then
	echo "==> Starting substrate stack (profile: $PROFILE)"
	prepare_app_armor_substrate_prereqs
	compose_substrate --profile "$PROFILE" up -d --build

	echo "==> Waiting for static build outputs"
	wait_for_completed_service takosumi-website-build
	wait_for_completed_service takosumi-docs-build
	wait_for_completed_service takosumi-dashboard-build

	# The static builders can replace .output/public after Caddy has already
	# bind-mounted it. Recreate Caddy so it sees the final directories.
	echo "==> Recreating Caddy after static builds"
	compose_ingress up -d --force-recreate caddy

	echo "==> Waiting for substrate services to become healthy"
	for _ in $(seq 1 120); do
		# Check OIDC discovery via Caddy as a proxy for full readiness.
		if curl -sk --cacert caddy/runtime/pebble-issuance-root.pem \
			--resolve app.takosumi.test:443:127.0.0.1 \
			https://app.takosumi.test/.well-known/openid-configuration \
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
   curl https://app.takosumi.test/.well-known/openid-configuration
   curl https://app.takosumi.test/healthz
   curl https://service-worker.takosumi.test/healthz  # local-only worker probe

Verify (profile=workers):
   curl https://app.takosumi.test/.well-known/openid-configuration
   curl https://service.takosumi.test/healthz         # local-only worker probe
EOF
