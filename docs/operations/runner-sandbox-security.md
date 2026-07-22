# Runner Sandbox Security Review

This runbook defines the technical review baseline for a Takosumi
RunnerProfile. It does not declare any production runner accepted. The
readiness `sandbox-review` gate remains incomplete until an accountable reviewer
accepts the exact immutable runner artifact and deployed substrate evidence.

## Responsibility split

Takosumi Core selects a RunnerProfile, pins Run inputs, evaluates policy, and
brokers phase-scoped credentials. The reference runner enforces command,
filesystem, redaction, and source/provider policy inside its process. The
selected executor/substrate owns container or microVM isolation, seccomp,
capabilities, filesystem mounts, network egress, resource limits, and teardown.

The OSS reference image executes module/provider code as the unprivileged
`bun` user. Application and provider-mirror files remain root-owned; only
bounded `/tmp` run/cache directories are writable. Non-root execution reduces
container breakout impact but is not a substitute for substrate isolation.

## Mandatory review checklist

- immutable image/artifact digest and reviewed source commit are recorded;
- final image user is non-root and no later layer resets it to root;
- executor drops unnecessary Linux capabilities, blocks privilege escalation,
  and provides a read-only base filesystem where supported;
- CPU, memory, process, timeout, source/archive, log, and artifact limits are
  enforced by the selected profile/substrate;
- allowed public egress succeeds and private/link-local/metadata/control-plane
  egress fails in the deployed runner;
- source checkout/build cannot read provider credentials;
- credential files are outside the source tree, restrictive, phase-scoped, and
  removed after success, failure, cancellation, and timeout;
- provider source/version/checksum and reviewed plan/source/state identity are
  rechecked before apply;
- state, Output, diagnostics, audit, usage, and hardening evidence contain no
  secret material;
- cancellation terminates the process group and the executor is not reused
  with residual tenant state;
- two-tenant isolation and drain/evacuation drills pass on the deployed
  substrate.

## Repository regression checks

```bash
cd takosumi
bun test tests/runner
bun test tests/core/domains/deploy-control/run_credential_broker_test.ts
bun test tests/worker/src/runner_credentials_test.ts
bun test tests/worker/src/runner_plan_apply_redaction_test.ts
bun test tests/worker/src/container_runner_redaction_test.ts
bun run check
```

These checks prove source behavior only. The selected deployed executor must
also produce `platform.hardening.*` evidence for runner execution, egress,
credential recipe, and secret boundary. Local Docker success does not prove a
Cloud or operator substrate.

## Acceptance record

The private record must contain:

- review id, reviewer, reviewed commit, runner artifact digest;
- RunnerProfile/executor identity and hardening contribution digest;
- repository check result and deployed isolation/egress evidence refs;
- residual risks, exceptions with owner/expiry, and decision.

Only `decision: accepted` may satisfy readiness. Automation may prepare the
checklist and technical results but must not invent the reviewer or decision.
