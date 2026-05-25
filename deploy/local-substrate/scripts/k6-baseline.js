// k6 load baseline against local-substrate via Caddy + TLS.
//
// Previously this script hit the worker directly over HTTP (docker network
// short-circuit), which gave great-looking numbers (~5ms p95) that didn't
// reflect what production users see. Now it goes through Caddy with the
// Pebble root injected as the system CA, so the numbers include TLS
// handshake + Caddy proxying overhead.
//
// Run via scripts/k6-baseline.sh which mounts the Pebble root and the
// docker network for us.
//
// NOTE: these thresholds are loose regression-watch numbers, NOT SLO
// targets. Production runs on Cloudflare's edge, not this machine.
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    install_dry_run: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "20s",
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "installationDryRun",
    },
    oidc_discovery: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "20s",
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "oidcDiscovery",
    },
  },
  thresholds: {
    "http_req_failed{scenario:install_dry_run}": ["rate<0.01"],
    "http_req_failed{scenario:oidc_discovery}": ["rate<0.01"],
    // Local Docker can temporarily stretch into seconds while worker
    // bundles are being rebuilt or containers are cold. This is a smoke
    // regression guard, not a production SLO; the error-rate thresholds
    // above catch broken routing/TLS, while these catch stuck handlers.
    "http_req_duration{scenario:install_dry_run}": ["p(95)<5000"],
    "http_req_duration{scenario:oidc_discovery}": ["p(95)<5000"],
  },
};

const INSTALLATION_DRY_RUN_URL =
  "https://cloud.takosumi.test/v1/installations/dry-run";
const OIDC_URL = "https://cloud.takosumi.test/.well-known/openid-configuration";
const LOCAL_CLOUD_SESSION_ID = __ENV.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID ||
  "sess_local_substrate";

export function installationDryRun() {
  const res = http.post(
    INSTALLATION_DRY_RUN_URL,
    JSON.stringify({
      spaceId: "space_local",
      source: {
        kind: "git",
        url: "https://github.com/tako0614/takos-docs.git",
        ref: "main",
      },
    }),
    {
      headers: {
        "Authorization": `Bearer ${LOCAL_CLOUD_SESSION_ID}`,
        "Content-Type": "application/json",
      },
    },
  );
  check(res, {
    "dry-run status 200": (r) => r.status === 200,
    "dry-run has appId": (r) => r.json("appId") !== undefined,
  });
}

export function oidcDiscovery() {
  const res = http.get(OIDC_URL);
  check(res, {
    "oidc status 200": (r) => r.status === 200,
    "oidc has authorization_endpoint": (r) =>
      r.json("authorization_endpoint") !== undefined,
  });
}
