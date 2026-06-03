#!/usr/bin/env bash
# Defense-in-depth assertion that the local-substrate cannot leak to
# public DNS / ACME endpoints. Three checks:
#
#   1. service: retired public deploy routes return 404, so raw source
#      posts cannot bypass the deploy control contract.
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

assert_retired_public_deploy_closed() {
	echo "==> [service] Verifying retired public deploy routes are closed"
	local leaked=0
	local paths=(
		"/v1/deployments"
		"/api/public/v1/deployments"
	)
	for path in "${paths[@]}"; do
		local http_code
		http_code=$(curl -sk \
			--cacert caddy/runtime/pebble-issuance-root.pem \
			--resolve accounts.takosumi.test:443:127.0.0.1 \
			-H "Authorization: Bearer ${TAKOSUMI_DEPLOY_TOKEN:-local-substrate-deploy-token}" \
			-H "Content-Type: application/json" \
			-d '{"source":{"git":{"url":"https://example.invalid/retired-route-probe.git","ref":"main"}}}' \
			-o /dev/null \
			-w "%{http_code}" \
			"https://accounts.takosumi.test${path}")
		if [[ "$http_code" != "404" ]]; then
			echo "    FAIL $path returned http=$http_code (expected 404)"
			leaked=$((leaked + 1))
		fi
	done
	if [[ "$leaked" -eq 0 ]]; then
		echo "    PASS retired deploy routes are not mounted"
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

assert_retired_public_deploy_closed
assert_coredns_nxdomain_letsencrypt
assert_mocks_not_host_published
recommend_egress_filter

echo
echo "==> ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]]
