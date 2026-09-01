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

## Narrow runner contract

The RunnerObject is the execution half of the RunOwner/RunnerObject boundary.
It receives one immutable, already-approved Run envelope, materializes only the
scoped ProviderConnection credential described by its CredentialRecipe and
ProviderBinding, executes the requested OpenTofu phase, and returns immutable
artifacts plus either a terminal result or the typed
`runner_mutation_indeterminate` outcome.

The result returns to RunOwner, not directly to ArtifactLedger. RunnerObject
may keep an executor-local delivery receipt to prevent a duplicate process or
provider call inside its substrate, but that receipt cannot authorize adoption,
artifact commit, or a current-state-pointer change. RunOwner alone validates the
exact result and authorizes the ledger commit.

The runner does not own scheduling, approval or review, retry policy, the
current-state pointer, Stack/Offering catalogs, billing, Host or Resource
lifecycle, or indeterminate-result adoption. RunOwner retains the durable
at-most-once Apply/Destroy mutation fence and the authority to reconcile or
adopt an exact post-dispatch result. Making the envelope narrow must not merge
RunOwner, the mutation fence, and the isolated executor; those boundaries have
different failure and security responsibilities.

## Worker relay memory and artifact limits

The Cloudflare runner relay must stay below the Worker isolate memory ceiling
even when a container or stored object is malformed. The following hard maxima
apply to plaintext artifacts:

| Artifact | Hard maximum |
| --- | ---: |
| source archive | 50 MiB |
| OpenTofu state | 16 MiB |
| reviewed binary plan | 24 MiB |
| raw output envelope | 4 MiB |
| container JSON result | 6 MiB |
| `current.json` state pointer | 64 KiB |

`TAKOSUMI_RUNNER_SOURCE_ARCHIVE_MAX_BYTES`,
`TAKOSUMI_RUNNER_STATE_ARTIFACT_MAX_BYTES`,
`TAKOSUMI_RUNNER_PLAN_ARTIFACT_MAX_BYTES`,
`TAKOSUMI_RUNNER_OUTPUT_ARTIFACT_MAX_BYTES`, and
`TAKOSUMI_RUNNER_RESPONSE_MAX_BYTES` may lower these values for a deployment;
they cannot raise the hard maxima. Plan JSON remains separately capped at
2 MiB.

Container responses are rejected from `Content-Length` before body allocation
when the declared length exceeds the cap. Missing, invalid, or forged smaller
lengths do not bypass enforcement: the relay reads the stream with a bounded
counter and cancels it on the first byte over the limit. R2 reads first check
the authoritative object size, then apply the same bound to the object body
stream (narrow test adapters without a stream recheck materialized length).

A limit failure is stable and non-retryable: HTTP `413` with
`errorCode: "artifact_size_limit_exceeded"` plus `artifact`, `maxBytes`, and
`observedBytes`. Source and plan objects are not written before validation.
Apply validates and encrypts state and output completely before it writes the
new output, state generation, or `current.json`, so a size failure leaves no
partial new generation.

New state, plan, and raw-output objects use
`aes-gcm-bytes-v2`: a short version prefix, a 12-byte IV, and byte-native
AES-GCM ciphertext/tag. This removes the former base64 plaintext copy from new
encrypt/decrypt operations. The reader still recognizes historical
base64-wrapped ciphertext and verifies its recorded plaintext digest; any
subsequent write emits v2 and records `takosumi-encryption-format` metadata.

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
