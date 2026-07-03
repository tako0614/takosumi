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
    deploy_control_read: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "20s",
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: "deployControlRead",
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
    "http_req_failed{scenario:deploy_control_read}": ["rate<0.01"],
    "http_req_failed{scenario:oidc_discovery}": ["rate<0.01"],
    // Local Docker can temporarily stretch into seconds while worker
    // bundles are being rebuilt or containers are cold. This is a smoke
    // regression guard, not a production SLO; the error-rate thresholds
    // above catch broken routing/TLS, while these catch stuck handlers.
    "http_req_duration{scenario:deploy_control_read}": ["p(95)<5000"],
    "http_req_duration{scenario:oidc_discovery}": ["p(95)<5000"],
  },
};

const RUNNER_PROFILES_URL =
  "https://app.takosumi.test/internal/v1/runner-profiles";
const OIDC_URL = "https://app.takosumi.test/.well-known/openid-configuration";
const DEPLOY_CONTROL_TOKEN =
  __ENV.TAKOSUMI_DEPLOY_CONTROL_TOKEN || "local-substrate-deploy-control-token";

export function deployControlRead() {
  const res = http.get(RUNNER_PROFILES_URL, {
    headers: {
      Authorization: `Bearer ${DEPLOY_CONTROL_TOKEN}`,
    },
  });
  check(res, {
    "runner profiles status 200": (r) => r.status === 200,
    "runner profiles present": (r) =>
      Array.isArray(r.json("runnerProfiles")) &&
      r.json("runnerProfiles").length > 0,
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
