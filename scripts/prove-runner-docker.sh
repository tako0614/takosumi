#!/usr/bin/env bash
#
# prove-runner-docker.sh
#
# End-to-end proof that the OpenTofu runner container image (runner/
# Dockerfile) works through REAL docker: build the image, run the container, and
# drive a real `tofu init/plan/apply` through the container's HTTP server using
# the SAME `takosumi.opentofu-run@v1` request envelope the production Durable
# Object (worker/src/durable/OpenTofuRunnerObject.ts) sends.
#
# It uses the baked-in provider-free `core` template (no cloud credentials):
#   - POST /runs/{runId} with a PLAN envelope  -> expect status=succeeded + planDigest
#   - POST /runs/{runId} with an APPLY envelope referencing the plan's
#     runner-local artifact -> expect outputs base_domain/public_origin/
#     member_issuer/service_registry_url
#
# The container keeps the plan workspace warm between plan and apply (the same
# container handles both), so the apply restores the runner-local tfplan from the
# still-warm /work/<runId> workspace with no R2 callback. This is exactly the
# runner-local artifact path the DO relies on before it promotes artifacts.
#
# Usage: scripts/prove-runner-docker.sh
# Run from anywhere; it resolves the repo root from its own location.
set -euo pipefail

# --------------------------------------------------------------------------
# Paths / constants
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_TAG="${TAKOSUMI_RUNNER_PROOF_IMAGE:-takosumi-runner-proof}"
CONTAINER_NAME="takosumi-runner-proof-$$"
RUN_ID="proof-$(date +%s)-$$"
PAYLOAD_TS="${SCRIPT_DIR}/prove-runner-docker-payload.ts"

PASS=0
FAIL=1

fail() {
  echo "FAIL: $*" >&2
  echo "==================================================================="
  echo "RESULT: FAIL"
  exit "${FAIL}"
}

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool not found: $1"
}
require docker
require bun
require curl

# --------------------------------------------------------------------------
# 1) Build the image (context MUST be the repo root).
# --------------------------------------------------------------------------
if [ "${TAKOSUMI_RUNNER_PROOF_SKIP_BUILD:-0}" = "1" ]; then
  docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1 \
    || fail "prebuilt image not found: ${IMAGE_TAG}"
  BUILD_SECONDS=0
  echo "STEP 1: using prebuilt image ${IMAGE_TAG}"
else
  echo "==================================================================="
  echo "STEP 1: docker build (context = repo root: ${REPO_ROOT})"
  echo "  This bakes an OpenTofu provider mirror; allow up to ~10 minutes."
  echo "==================================================================="
  BUILD_START="$(date +%s)"
  build_image() {
    docker build \
      -f "${REPO_ROOT}/runner/Dockerfile" \
      -t "${IMAGE_TAG}" \
      "${REPO_ROOT}"
  }
  if ! build_image; then
    echo "WARN: docker build failed; retrying once (transient network on mirror layer)..." >&2
    sleep 5
    build_image || fail "docker build failed after retry"
  fi
  BUILD_END="$(date +%s)"
  BUILD_SECONDS=$(( BUILD_END - BUILD_START ))
  echo "docker build completed in ${BUILD_SECONDS}s"
fi

IMAGE_SIZE="$(docker image inspect "${IMAGE_TAG}" --format '{{.Size}}' 2>/dev/null || echo 0)"
IMAGE_SIZE_HUMAN="$(awk -v b="${IMAGE_SIZE}" 'BEGIN{printf "%.2f MB", b/1024/1024}')"
echo "image size: ${IMAGE_SIZE_HUMAN} (${IMAGE_SIZE} bytes)"

# --------------------------------------------------------------------------
# 2) Run the container detached, mapping container 8080 to a host-chosen port.
# --------------------------------------------------------------------------
echo "==================================================================="
echo "STEP 2: run container detached"
echo "==================================================================="
# Let docker pick a free host port for container 8080.
DOCKER_RUN_ARGS=(-d --name "${CONTAINER_NAME}" -p 0:8080)
if [ "${TAKOSUMI_RUNNER_PROOF_APPARMOR_UNCONFINED:-0}" = "1" ]; then
  DOCKER_RUN_ARGS+=(--security-opt apparmor=unconfined)
fi
docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_TAG}" >/dev/null \
  || fail "docker run failed"

HOST_PORT="$(docker port "${CONTAINER_NAME}" 8080/tcp | head -n1 | sed 's/.*://')"
[ -n "${HOST_PORT}" ] || fail "could not resolve mapped host port"
BASE_URL="http://127.0.0.1:${HOST_PORT}"
echo "container ${CONTAINER_NAME} listening on ${BASE_URL}"

# --------------------------------------------------------------------------
# 3) Wait for readiness (GET /healthz -> {"ok":true,...}).
# --------------------------------------------------------------------------
echo "STEP 3: wait for /healthz readiness"
READY=""
for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [ -z "${READY}" ]; then
  echo "----- container logs -----" >&2
  docker logs "${CONTAINER_NAME}" >&2 || true
  fail "runner did not become ready on ${BASE_URL}/healthz"
fi
echo "runner is ready: $(curl -fsS "${BASE_URL}/healthz")"

# --------------------------------------------------------------------------
# 4) PLAN: POST the plan envelope; assert status=succeeded + planDigest.
# --------------------------------------------------------------------------
echo "==================================================================="
echo "STEP 4: POST plan envelope -> /runs/${RUN_ID}"
echo "==================================================================="
PLAN_PAYLOAD="$(bun run "${PAYLOAD_TS}" plan "${RUN_ID}")"
PLAN_RESPONSE="$(curl -sS -X POST \
  -H 'content-type: application/json' \
  --data-binary "${PLAN_PAYLOAD}" \
  "${BASE_URL}/runs/${RUN_ID}")"

echo "plan response (key fields):"
echo "${PLAN_RESPONSE}" | bun -e '
  const r = JSON.parse(await Bun.stdin.text());
  console.log("  status     :", r.status);
  console.log("  exitCode   :", r.exitCode);
  console.log("  planDigest :", r.planDigest);
  console.log("  planArtifact.kind:", r.planArtifact && r.planArtifact.kind);
  console.log("  summary    :", JSON.stringify(r.summary));
  console.log("  plannedOutputs:", JSON.stringify(r.plannedOutputs));
  if (r.status !== "succeeded") {
    console.log("  stderr     :", (r.stderr||"").slice(0,2000));
    console.log("  stdout     :", (r.stdout||"").slice(0,2000));
  }
'

PLAN_STATUS="$(echo "${PLAN_RESPONSE}" | bun -e 'console.log((JSON.parse(await Bun.stdin.text()).status)||"")')"
PLAN_DIGEST="$(echo "${PLAN_RESPONSE}" | bun -e 'console.log((JSON.parse(await Bun.stdin.text()).planDigest)||"")')"
PLANNED_OUTPUTS_OK="$(echo "${PLAN_RESPONSE}" | bun -e '
  const r = JSON.parse(await Bun.stdin.text());
  const o = r.plannedOutputs || {};
  const val = (k) => o[k] && typeof o[k] === "object" ? o[k].value : o[k];
  const expected = {
    base_domain: "proof.example.com",
    public_origin: "https://proof.example.com",
    member_issuer: "https://proof.example.com/auth",
    service_registry_url: "https://proof.example.com/.well-known/takosumi-services.json",
  };
  console.log(Object.entries(expected).every(([k, v]) => val(k) === v) ? "ok" : "no");
')"

if [ "${PLAN_STATUS}" = "succeeded" ] && [ -n "${PLAN_DIGEST}" ] && [ "${PLAN_DIGEST}" != "undefined" ] && [ "${PLANNED_OUTPUTS_OK}" = "ok" ]; then
  echo "PLAN: PASS (status=succeeded, planned outputs present, planDigest=${PLAN_DIGEST})"
else
  fail "plan contract failed (status=${PLAN_STATUS}, planDigest=${PLAN_DIGEST}, plannedOutputs=${PLANNED_OUTPUTS_OK})"
fi

# --------------------------------------------------------------------------
# 5) APPLY: POST the apply envelope referencing the plan's runner-local
#    artifact (by digest); assert the 4 core outputs.
# --------------------------------------------------------------------------
echo "==================================================================="
echo "STEP 5: POST apply envelope -> /runs/${RUN_ID} (references plan digest)"
echo "==================================================================="
APPLY_PAYLOAD="$(bun run "${PAYLOAD_TS}" apply "${RUN_ID}" "${PLAN_DIGEST}")"
APPLY_RESPONSE="$(curl -sS -X POST \
  -H 'content-type: application/json' \
  --data-binary "${APPLY_PAYLOAD}" \
  "${BASE_URL}/runs/${RUN_ID}")"

echo "apply response (key fields):"
echo "${APPLY_RESPONSE}" | bun -e '
  const r = JSON.parse(await Bun.stdin.text());
  console.log("  status   :", r.status);
  console.log("  exitCode :", r.exitCode);
  const o = r.outputs || {};
  const val = (k) => o[k] && typeof o[k] === "object" ? o[k].value : o[k];
  console.log("  base_domain          :", val("base_domain"));
  console.log("  public_origin        :", val("public_origin"));
  console.log("  member_issuer        :", val("member_issuer"));
  console.log("  service_registry_url :", val("service_registry_url"));
  if (r.status !== "succeeded") {
    console.log("  stderr   :", (r.stderr||"").slice(0,2000));
    console.log("  stdout   :", (r.stdout||"").slice(0,2000));
  }
'

# Assert apply succeeded AND all four outputs are present + non-empty.
APPLY_OK="$(echo "${APPLY_RESPONSE}" | bun -e '
  const r = JSON.parse(await Bun.stdin.text());
  const o = r.outputs || {};
  const val = (k) => o[k] && typeof o[k] === "object" ? o[k].value : o[k];
  const required = ["base_domain","public_origin","member_issuer","service_registry_url"];
  const ok = r.status === "succeeded" &&
    required.every((k) => typeof val(k) === "string" && val(k).length > 0);
  console.log(ok ? "ok" : "no");
')"

if [ "${APPLY_OK}" = "ok" ]; then
  echo "APPLY: PASS (status=succeeded, all 4 outputs present)"
else
  fail "apply did not produce all required outputs"
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo "==================================================================="
echo "image size      : ${IMAGE_SIZE_HUMAN}"
echo "build time      : ${BUILD_SECONDS}s"
echo "plan            : PASS"
echo "apply           : PASS"
echo "RESULT: PASS"
echo "==================================================================="
exit "${PASS}"
