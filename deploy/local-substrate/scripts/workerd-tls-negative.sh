#!/usr/bin/env bash
# Proves workerd keeps TLS verification enabled: the local Pebble-issued
# oauth-mock certificate must fail when the dedicated trustedCertificates entry
# is omitted. The positive path is the full oauth-e2e.sh authorize/callback
# flow through the composed platform Worker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SUBSTRATE_DIR"
source "$SCRIPT_DIR/compose-helpers.sh"

PROFILE="${TAKOSUMI_LOCAL_SUBSTRATE_PROFILE:-workers}"
case "$PROFILE" in
	postgres|workers) ;;
	*)
		echo "TAKOSUMI_LOCAL_SUBSTRATE_PROFILE must be postgres or workers" >&2
		exit 1
		;;
esac

IMAGE_ID="$(compose_substrate --profile "$PROFILE" images -q takosumi-service-worker | head -n 1)"
if [[ -z "$IMAGE_ID" ]]; then
	echo "takosumi-service-worker image is unavailable; run scripts/up.sh --profile $PROFILE first" >&2
	exit 1
fi

local_substrate_docker_run --rm -i \
	--network local-substrate_takos-local-internal \
	"$IMAGE_ID" node --input-type=module <<'NODE'
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  script: `export default {
    async fetch() {
      try {
        const response = await fetch("https://oauth-mock.test/local-oidc/userinfo");
        return Response.json({ connected: true, status: response.status });
      } catch {
        return Response.json({ connected: false });
      }
    }
  }`,
  port: 0,
  cf: false,
  compatibilityDate: "2026-04-15",
  outboundService: {
    network: {
      // Match Miniflare's normal egress reachability so this proof isolates
      // certificate trust rather than failing at private-address filtering.
      allow: ["public", "private", "240.0.0.0/4"],
      tlsOptions: { trustBrowserCas: true },
    },
  },
});

try {
  const response = await mf.dispatchFetch("http://workerd-tls-negative.test/");
  const result = await response.json();
  if (result.connected !== false) {
    throw new Error(
      `workerd unexpectedly trusted the Pebble-issued certificate: ${JSON.stringify(result)}`,
    );
  }
  console.log("OK workerd rejected the untrusted Pebble issuance chain");
} finally {
  await mf.dispose();
}
NODE
