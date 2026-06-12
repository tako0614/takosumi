#!/usr/bin/env bash
# Defense-in-depth assertion that the local-substrate cannot leak to
# public DNS / ACME endpoints. Three checks:
#
#   1. service: the /internal/v1 deploy-control seam (and the retired
#      unversioned /api core-seam strings) return 404 at the public edge, so the
#      in-process seam cannot be reached from outside. The only edge-public
#      deploy-control surface is /api/v1.
#   2. CoreDNS: any letsencrypt.org name returns NXDOMAIN.
#   3. host firewall: the script *recommends* nftables / iptables egress
#      filtering (we don't apply it here, since it requires root and varies
#      per host). Defense at the Docker network layer is left to operator.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SUBSTRATE_DIR"

PASS=0
FAIL=0

assert_internal_seam_not_edge_reachable() {
	echo "==> [service] Verifying the /internal/v1 deploy-control seam is not edge-reachable"
	local leaked=0
	# The /internal/v1 seam (deploy-control ledger + runtime-agent gateway +
	# container callbacks) is dialed in-process only; it must never answer at the
	# public edge. The single edge-public deploy-control surface is /api/v1.
	# An operator-bearer probe to a seam path must 404 (route not mounted at the
	# edge), NOT 401/200 (which would mean the seam leaked to the edge).
	# We also probe the retired unversioned `/api/...` core-seam strings, which
	# must likewise not be edge-reachable after the /internal/v1 cutover.
	local paths=(
		"/internal/v1/spaces"
		"/internal/v1/plan-runs"
		"/internal/v1/apply-runs"
		"/internal/v1/runner-profiles"
		"/internal/v1/sources"
		"/internal/v1/connections"
		"/internal/v1/runtime/agents/enroll"
		"/api/spaces"
		"/api/connections"
	)
	for path in "${paths[@]}"; do
		local http_code
		http_code=$(curl -sk \
			--cacert caddy/runtime/pebble-issuance-root.pem \
			--resolve app.takosumi.test:443:127.0.0.1 \
			-H "Authorization: Bearer ${TAKOSUMI_DEPLOY_CONTROL_TOKEN:-local-substrate-deploy-control-token}" \
			-H "Content-Type: application/json" \
			-o /dev/null \
			-w "%{http_code}" \
			"https://app.takosumi.test${path}")
		if [[ "$http_code" != "404" ]]; then
			echo "    FAIL $path returned http=$http_code (expected 404 — seam leaked to the edge)"
			leaked=$((leaked + 1))
		fi
	done
	if [[ "$leaked" -eq 0 ]]; then
		echo "    PASS /internal/v1 seam (and retired /api core-seam strings) are not edge-mounted"
		PASS=$((PASS + 1))
	else
		FAIL=$((FAIL + 1))
	fi
}

assert_coredns_nxdomain_letsencrypt() {
	echo "==> [coredns] Querying letsencrypt.org via CoreDNS"
	local rcode
	rcode=$(dig +noall +comments acme-v02.api.letsencrypt.org @127.0.0.1 \
		2>/dev/null | grep -oP "status: \K[A-Z]+" | head -1)
	if [[ "$rcode" == "NXDOMAIN" ]]; then
		echo "    PASS NXDOMAIN (CoreDNS denies letsencrypt.org)"
		PASS=$((PASS + 1))
	else
		echo "    FAIL rcode=$rcode (expected NXDOMAIN)"
		FAIL=$((FAIL + 1))
	fi
}

recommend_egress_filter() {
	cat <<EOF

==> [recommendation] Network egress filter (host nftables)

The Docker network blocks DNS queries that try to leak to public Let's Encrypt,
but a fully isolated runbook should also nft-block egress from service/runtime-agent
container subnet to public ACME directories. Example:

   sudo nft add table inet takos-deny
   sudo nft add chain inet takos-deny out '{ type filter hook output priority -10 ; }'
   sudo nft add rule inet takos-deny out ip daddr { 23.85.43.146, 172.65.32.248 } drop comment "Let's Encrypt prod"

This is operator-owned. Re-evaluate addresses periodically.
EOF
}

assert_mocks_not_host_published() {
	# The emulator services (oauth-mock, mailpit web UI, jaeger UI,
	# otel-collector, minio, and the
	# Miniflare worker mirrors) must stay on the internal docker
	# network. If anyone accidentally adds a `ports:` entry that
	# publishes them to 0.0.0.0, this catches it.
	echo "==> [docker] Verifying new mock/emulator containers do not bind 0.0.0.0"
	local leaked=0
	local services=(
		oauth-mock
		mailpit
		jaeger
		otel-collector
		minio
		takosumi-worker
		takosumi-service-worker
	)
	for svc in "${services[@]}"; do
		local cid
		cid=$(docker ps --filter "name=local-substrate-${svc}-1" --format '{{.ID}}' | head -1)
		if [[ -z "$cid" ]]; then continue; fi
		local public
		public=$(docker port "$cid" 2>/dev/null | grep -E '^.* -> 0\.0\.0\.0:' || true)
		if [[ -n "$public" ]]; then
			echo "    FAIL [docker.no-public-publish.$svc] container is published to host:"
			echo "$public" | sed 's/^/        /'
			leaked=$((leaked + 1))
		fi
	done
	if [[ "$leaked" -eq 0 ]]; then
		echo "    PASS all ${#services[@]} mock/emulator services are internal-only (no 0.0.0.0 bind)"
		PASS=$((PASS + 1))
	else
		FAIL=$((FAIL + 1))
	fi
}

assert_internal_seam_not_edge_reachable
assert_coredns_nxdomain_letsencrypt
assert_mocks_not_host_published
recommend_egress_filter

echo
echo "==> ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
