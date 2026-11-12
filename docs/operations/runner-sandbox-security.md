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

For each source build, the reference Runner uses a dedicated Linux child
subreaper. It drains that build's adopted descendants before later phases may
materialize provider or runtime files in the same Runner process. An
unconfirmed drain makes that process refuse later sensitive phases. This
process-local ordering does not isolate another Runner process under the same
UID, survive a Runner restart, or replace the selected substrate's tenant
isolation and teardown evidence.

## Git configuration inputs

Runner command environments ignore ambient global and system Git configuration.
`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point to `/dev/null`, with
`GIT_CONFIG_NOSYSTEM=1`. Source credentials cannot replace these runtime-owned
controls. This prevents an earlier build's HOME config from redirecting a later
credentialed Git operation through `url.*.insteadOf` or an implicit helper.

SSH source commands also use `-F /dev/null`, while retaining the minted
`known_hosts`, strict host checking, explicit identity and batch-mode controls.
Both a minted key and `known_hosts` are required; global known-host databases
and default user identities cannot supply missing source credentials. Credential
paths are quoted for both the shell and SSH, and unsupported SSH environment
expansion syntax is rejected before files are written.
Git HTTPS custom trust can use the existing explicit `GIT_SSL_CAINFO` input;
the existing `SSL_CERT_FILE` and `SSL_CERT_DIR` passthrough is retained. Ambient
Git/SSH config is not a source-credential input.

HTTPS source sync and stable-tag discovery require Git 2.37 or newer. They
reject HTTP redirects and pass the complete validated public DNS address set
to Git through `http.curloptResolve`, preserving the original hostname and TLS
verification. The same non-expiring pin covers ref lookup and both shallow
fetch attempts. Literal IP URLs need no DNS pin and also refuse redirects.
Use the final repository URL rather than relying on a forge redirect. The
reference image checks the Git minimum at build time; each HTTPS operation
also refuses an unsupported runtime before any remote Git command.
For hostname URLs, the Linux x64/arm64 runtime must expose its Git HTTPS
helper's one dynamically linked libcurl through `ldd`. A bounded, credential-free
Bun child reads that actual library's runtime version and IPv6 feature through
`curl_version_info`; libcurl 7.59 or newer and support for every resolved address
family are required. Static/unknown linkage, an unsupported ABI, unavailable
native inspection, and failed inspection refuse before remote execution.
Git build headers and a separate `curl` executable are not capability evidence.
Bun's experimental FFI is confined to this read-only child; a crash or timeout
fails the check and leaves the Runner process intact. No network probe is used.

This HTTPS transport pin does not pin SSH destinations. SSH retains its
existing preflight and minted host-key controls and requires substrate egress
or source-host controls for connection-time address enforcement.

Each command phase now gets a fresh private HOME outside its Run workspace,
with a fresh `XDG_CONFIG_HOME` when the selected provider input has not
explicitly declared one. All commands in one `sourceBuild` share its HOME;
the next source sync, compatibility, backup, Plan, Apply, or release command
phase gets another. The Runner removes a source-build HOME only after the
dedicated child proves descendant drain. An unconfirmed drain retains that
directory and poisons later command phases. A failed HOME cleanup also poisons
later phases without replacing a completed Run result.

Explicit provider `XDG_CONFIG_HOME` inputs and explicit config arguments in
build commands remain selected inputs. The configured source-build dependency
cache and provider cache remain shared where configured; neither is placed in
phase HOME. This process-local default does not isolate processes sharing a UID,
shared caches, or a runner filesystem reused across boots. The selected
substrate still supplies tenant isolation and teardown evidence.

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

Source archives also have a fixed ceiling of 50,000 entries, counting regular
files, directories and the archive root. Git tree and tar listing commands
have a combined stdout/stderr limit of 32 MiB; the Runner stops their process
group on overflow. Source profiles cannot raise these limits. Generated archives
are size-checked before reading, and relay uploads and restore bodies use a
bounded reader before writing or clearing the workspace. Oversized declarations
are rejected without reading their body; stream overflow cancels further reads.

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
