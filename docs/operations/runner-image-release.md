# Takosumi runner image release

`takosumi-runner` is the OpenTofu execution image used by the Cloudflare
reference composition. Takosumi owns both the runner source and its release
implementation: `runner/Dockerfile`, the `runner/` payload, and
`scripts/runner-image-release.ts` live here. `takosumi-private` owns the
official realized image pin and operator evidence. Realized configuration,
credentials, and release records never belong in this public repository.

There are two distinct authorities:

- `takosumi-runner-image build` is the only runner image publication mutation.
- `takosumi-platform-staging` / `takosumi-platform` plan and execute are the
  only full Worker and Container configuration mutation. Runner `verify` is a
  readback-only post-step and never invokes `wrangler deploy`.

All commands are exposed through Takosumi's single `bun run deploy` entrypoint.
`build` and `verify` are read-only without `--execute`; executing either
requires a bounded named `--review` identity. `reconcile` is always externally
read-only and never accepts `--execute`.

## Source and configuration gates

Both runner operations require clean attached source. `staging` accepts the
current feature branch only when `HEAD` equals both local
`origin/<current-branch>` and a fresh `git ls-remote` read of the same branch.
`production` additionally requires `main`, with `HEAD` exactly equal to pushed
`origin/main`. The evidence records the branch and commit.

The external Wrangler config must use exactly `takosumi-staging` or `takosumi`
for the selected environment. Its `main` resolves exactly to this checkout's
`deploy/platform/entry-worker.ts`, its asset directory resolves exactly to this
checkout's `dashboard/dist`, and it contains exactly one
`OpenTofuRunnerObject` image pinned by immutable registry digest.

Publication state, plans, checkpoints, and evidence are absolute, physical,
single-link files in operator-private directories outside every Git worktree,
and use exact mode `0600`. `takosumi-private` owns their policy and realized
pin, but these runtime files are not written inside that checkout. Records
contain bounded, redacted diagnostics and digest fields, never secrets.
Before any evidence or coordination file is opened, the runner CLI canonicalizes
existing and future paths and requires the realized config, publication state,
terminal evidence, build/platform input evidence, deterministic locator, lock,
and reserved pending-lock namespace to be pairwise distinct. Canonical path and
physical inode equality both fail closed, so a symlinked parent or hardlink
cannot turn append-only JSON output into config or coordination corruption.

## 1. Publish an immutable image

```bash
cd /absolute/path/to/takosumi
bun run deploy -- takosumi-runner-image build \
  --config /absolute/operator-private/wrangler.staging.toml \
  --environment staging \
  --release release-2026-08-27 \
  --state /absolute/non-worktree-release-state/runner-publication.jsonl \
  --evidence /absolute/non-worktree-release-state/runner-build.jsonl \
  --review operator:<reviewer> \
  --execute
```

Build materializes the exact pushed Git commit into an external physical build
context, copies the already-validated config into the same private custody, and
builds that sealed source for `linux/amd64`. Before Docker runs it downloads the
OpenTofu checksum, certificate, and signature named by the sealed Dockerfile,
verifies the checksum file with Cosign against OpenTofu's release workflow OIDC
identity and issuer, and requires the pinned linux/amd64 archive checksum to be
present exactly once. It then generates a collision-resistant transport tag
bound to the source commit, Dockerfile content, and a cryptographic nonce. That
mutable tag is transport only: it is never a release version, consumer input,
or published identity, and the implementation does not perform a racy
check-then-push.

For an executing build, `CLOUDFLARE_ACCOUNT_ID` must be exactly the account in
the realized previous-image repository. That checked publication repository,
not an independently parsed config value or caller-selected state path, is the
target identity used by the journal and lock. A mismatched prior pin therefore
cannot fork coordination while pushing to the same registry target.

Immediately before the one push, build fsyncs the exact transport reference,
local image config digest, sealed source/config identities, and reviewer to the
publication state journal. After the push it reads Docker 29's exact
`Descriptor.platform`, requires one `linux/amd64` manifest, and requires the
remote manifest config digest to equal the locally inspected image ID. A local
tag race therefore cannot produce trusted evidence for different uploaded
bytes. The sole published and consumer identity is the resulting
content-addressed
`registry.cloudflare.com/.../takosumi-runner@sha256:...` digest. Content digest
immutability is the no-overwrite property. If publication acknowledgement or
manifest readback is missing or ambiguous, evidence records an unknown
publication outcome and does not claim an immutable identity.

Any unresolved journal entry blocks every future build before a new nonce or
push. The environment plus checked publication repository select one fixed
operator-account journal locator. The locator binds the exact journal path and
physical file identity and the operator machine/PID namespace; a missing,
replaced, or cross-host journal is never recreated as empty. This is an
enforced single-physical-host/PID-namespace authority, not a distributed lock:
do not put its locator root on a home/state directory shared by multiple
operator hosts. A foreign host, namespace, or boot lock fails closed and is
never auto-reclaimed.

An exclusive release-scope lock covers the unresolved check through the
publication attempt. The implementation first writes and fsyncs a complete
machine/boot/PID-start/path/inode record to a private pending inode, then
atomically links that complete record at the canonical no-overwrite lock path.
A crash before that link leaves no canonical lock; a crash after it leaves a
complete record whose dead local owner can be verified before reclamation.
The locked operation keeps the exact locator and journal descriptors open for
all reads and appends and revalidates both physical paths immediately before
push, so path rotation cannot substitute an empty journal. Supplying another
`--state` path therefore cannot fork the journal or race a second push. New
journal, locator, and lock entries are fsynced together with their containing
directories. A build never adopts a pre-existing nonempty unbound journal;
only the explicit read-only reconcile flow may bind it before inspecting the
one recorded tag. Reconcile that exact tag without mutation:

```bash
bun run deploy -- takosumi-runner-image reconcile \
  --config /absolute/operator-private/wrangler.staging.toml \
  --environment staging \
  --release release-2026-08-27 \
  --state /absolute/non-worktree-release-state/runner-publication.jsonl \
  --evidence /absolute/non-worktree-release-state/runner-reconcile.jsonl
```

Reconcile records either the exact remotely observed immutable digest with the
same image-config digest or an exact-tag authoritative manifest absence. Auth,
network, TLS, malformed, or ambiguous failures leave the journal unresolved.

The successful build record retains the previous digest and computes the exact
expected activation config SHA by replacing only the unique runner image
literal. Route, binding, migration, compatibility, Container field, comment,
whitespace, or any other byte change produces a different SHA and is refused.

## 2. Change only the realized pin and release the platform

In the operator-owned realized config, replace only the recorded previous
runner image literal with the selected immutable digest. Then use the existing
platform authority:

```bash
bun run deploy -- takosumi-platform-staging plan \
  --config /absolute/operator-private/wrangler.staging.toml \
  --plan-out /absolute/non-worktree-release-state/platform-plan.json

bun run deploy -- takosumi-platform-staging execute \
  --plan /absolute/non-worktree-release-state/platform-plan.json \
  --confirm sha256:<reviewed-plan-digest> \
  --review operator:<reviewer> \
  --evidence /absolute/non-worktree-release-state/platform-evidence.json
```

For production, use `takosumi-platform`. The platform plan seals the exact
config SHA, complete dashboard asset tree, deterministic dry-run tree, source,
secret-name inventory, and predecessor Worker Version. The plan retains an
external sealed Git/config/assets/dry-run closure; execute uploads its exact
dry-run entry from a fresh re-sealed custody copy with `--no-bundle` and does
not re-read live source, the retained plan tree, or asset bytes. Execute uses
immediate Container rollout with Wrangler strict conflict
detection. A durable checkpoint is fsynced before the provider command;
alternate evidence paths cannot cause a second upload. Ready evidence exists
only after the one emitted Worker Version UUID is alone at 100 percent, that
immutable tagged Version passes binding readback, and public responses emit the
same Version ID.

## 3. Verify the runner application

```bash
bun run deploy -- takosumi-runner-image verify \
  --config /absolute/operator-private/wrangler.staging.toml \
  --environment staging \
  --release release-2026-08-27 \
  --build-evidence /absolute/non-worktree-release-state/runner-build.jsonl \
  --platform-evidence /absolute/non-worktree-release-state/platform-evidence.json \
  --evidence /absolute/non-worktree-release-state/runner-verify.jsonl \
  --review operator:<reviewer> \
  --execute
```

Verify requires the current config SHA to equal the build record's exact
image-only transform and the platform ready evidence to bind that same config,
source commit, and serving Worker Version. It then requires exactly
`takosumi-staging-opentofurunnerobject` or
`takosumi-opentofurunnerobject`, with matching list/detail identity, the exact
selected digest, no active rollout, `active`/`ready` state, and zero failed,
starting, scheduling, or error entries. Readback is bounded; an unsettled or
ambiguous application records incomplete evidence and never causes a Worker
mutation.

## Rollback

The build evidence retains the exact previous immutable image, and platform
evidence retains the exact predecessor Worker Version. Choose either a forward
repair or a reviewed restore; do not blind-retry an unknown publication or
platform mutation. The reviewed platform plan also retains the exact predecessor
Container application/image state and an image-only sealed restore closure. Use
that same plan with the environment's `takosumi-platform[-staging] restore`
action: it restores the predecessor Container image with immediate rollout,
then the exact predecessor Worker Version at 100 percent, and requires both
public Version and authoritative Container identity/image/health readback.
Follow it with runner verification. Do not use a raw image push, Worker deploy,
or copied Wrangler rollback command as an alternate official release path.

## Local verification

```bash
bun run check:runner-image-release
bun run deploy -- --contract
```

The focused check covers pushed-branch policy, exact entrypoint and image-only
config binding, collision-resistant transport publication, immutable digest
readback, complete asset and dry-run authority fences, emitted/serving Version
identity, durable recovery, and exact Container application health. The same
tests run once in the portable repository gate through the global test phase.
