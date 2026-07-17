# Provider release and mirror operation

This runbook covers the Takosumi-owned legacy/admin provider release lane. The
provider version is owned by `provider/release/version.json`; `package.json`
does not select it.

The current provider is a compatibility/admin client of the Takosumi Deploy
API. It retains the mixed `takosumi_*` Resource Shape state and
`takosumi_target_pool` while the future portable Service Form provider is
separated. Neither provider release defines host availability, a Cloud
ServiceOffering, backend selection, or price.

`provider/release/registry.json` plus its SHA-256 sidecar is the normal mirror
admission authority. It lists every known immutable version. Historical
quarantine entries remain materializable for compatibility; a corrected
candidate does not enter the hosted mirror until a separately reviewed
approved entry has artifact-signature and transparency evidence. Direct
manifest selection exists only behind an explicit test-only environment seam.

## Historical `1.0.0` quarantine

`provider/release/quarantine/1.0.0.json` inventories the exact public version
document and four archives with URL, path, byte size, SHA-256, ETag, cache
policy, and observation time. It records the public `index.json` separately as
an `indexObservation`: the index is a mutable aggregate catalog, not an
immutable `1.0.0` asset. The served binary reports:

```text
archive/index version: 1.0.0
provider main.version: dev
Go:                    go1.26.0
source revision:       06319f127353410d97f7966fb82f579f3e6245b6
vcs.modified:          true
provenance:            unknown-dirty
```

These bytes may remain necessary for existing lock/state compatibility. They
are not reproducible release evidence. Never upload a local rebuild to a
`1.0.0` path, even when its HCL schema appears unchanged.

## Normal check and generated mirror

```bash
bun run provider:assets
cd dashboard && bun run build
```

The first command verifies descriptor/registry/manifest digest sidecars, the
independent candidate version, all-known-version retention, duplicate-version
rule, and ignored local mirror drift. It never builds Go.
The dashboard build removes the generated `dist/opentofu/providers` overlay,
downloads or reuses a content-addressed cache entry for each exact reviewed
version/archive asset, verifies it, and copies the bytes unchanged. It then
derives `index.json` by deterministically merging the version entries from all
reviewed manifests. Adding `1.1.0` can change that aggregate catalog but cannot
change any `1.0.0` byte. Missing, conflicting, or mismatched bytes fail the
build. Files under ignored
`dashboard/public/.../registry.opentofu.org` are generated only by the
immutable materializer for local dev. Wrong, unreviewed, or tracked provider
bytes fail the dev/build preflight and must be removed; an ignored source-tree
rebuild is never selected as release authority.

Run the connected installation proof separately:

```bash
bun run provider:mirror:proof
```

It configures the public HTTPS network mirror, pins `1.0.0`, runs OpenTofu init
without a dev override or direct fallback, and verifies the lock/install
evidence. Repository checks do not substitute for this live distribution
proof.

## Candidate schema and old-state compatibility

Before building or approving the correction candidate, run:

```bash
bun run provider:compatibility:check
bun run provider:compatibility:state-proof
bun run provider:compatibility:release-check
```

The first command builds `1.1.0` in a temporary directory and compares the
OpenTofu machine schema to the digest-pinned, value-free identity captured from
the exact public `1.0.0` archive. After removing only the policy-declared delta,
the historical provider schema and seven historical resource schemas must
match. The declared delta is four resources (`durable_workflow`, `schedule`,
`stateful_actor_namespace`, and `vector_index`) and nine optional attributes
on EdgeWorker, ObjectBucket, and TargetPool. Their complete machine schemas are
also pinned, and implementation-source digests cover defaults and validators
that OpenTofu schema JSON omits. Any removal, required/sensitive/type/nesting,
default/validator change, or undeclared addition fails.

The state proof uses only a temporary directory and a local fake endpoint. It
installs exact public `1.0.0`, applies disposable state for all seven historical
resource types, switches to the current candidate, requires a refresh-free
no-op and read-only observe refresh, then switches back and requires an
old-provider no-op before destroy. It prints no state values and uses no
credential. It also guards the ObjectBucket compatibility correction that
keeps omission materialized as `standard` without a plan-time default forcing
pre-field state to update. A second real current-provider apply proves the
omitted create value is known `standard`. All proof subprocesses use an
explicit, credential-free environment allowlist, and every phase asserts exact
per-resource plus TargetPool request-count deltas.

`release-check` remains intentionally failing until all release blockers are
resolved. The feature-bearing `1.0.1` patch is rejected; the classified four
resources and nine fields stay only in the `1.1.0` minor candidate. The
supported Terraform install matrix must be run with its reviewed CLI, with
OpenTofu proved under `registry.opentofu.org/takosjp/takosumi` and Terraform
proved under `registry.terraform.io/takosjp/takosumi`. A missing
Terraform CLI is `blocked-prerequisite`, never `skipped`; a CLI found on `PATH`
clears only that prerequisite and does not claim matrix evidence.

## Build a corrected candidate

The current corrected version is `1.1.0` and remains unpublished. After the
release change is committed, create the exact clean provider tag according to
the release approval process. A production build accepts only an annotated tag
whose signature matches a reviewed fingerprint in `version.json`. That signer
list is intentionally empty until key custody is approved, so the command
below is currently blocked rather than publication-ready. The output path must
not exist and must be outside the repository:

```bash
commit=$(git rev-parse 'refs/tags/provider/v1.1.0^{commit}')
bun run provider:release:build -- \
  --tag provider/v1.1.0 \
  --source-commit "$commit" \
  --output /srv/takosumi-provider-candidates/1.1.0
```

The command fails when the caller checkout or detached tagged worktree is
dirty, the tag and commit differ, the signed tag fingerprint is not reviewed,
a Go module replacement exists, any absolute Go/zip/unzip/Git/gpgv executable
path/version/digest differs, the full Go distribution or runtime shared-library
digest differs, the pinned signer keyring differs, the output/version already
exists, binary `main.version` or Go build metadata differs, or either
independent build differs byte-for-byte. Git is executed with system/global
configuration, hooks, fsmonitor, attributes, and implicit signing disabled;
gpgv verifies the captured annotated-tag payload directly against the pinned
keyring. Go dependency resolution is offline (`GOPROXY=off`) and `go mod
verify` must validate the pre-populated module cache before compilation.
Release output
contains:

```text
mirror/<provider-address>/index.json
mirror/<provider-address>/<version>.json
mirror/<provider-address>/terraform-provider-...zip (four platforms)
checksums.txt
sbom.spdx.json
provenance.intoto.json
release-manifest.json
release-manifest.json.sha256
```

Re-verify a reviewed release bundle before it can be considered for
publication:

```bash
bun run provider:release:verify -- --root /srv/takosumi-provider-candidates/1.1.0
```

This gate captures each input file once into a private `0700` snapshot with
`0600` files, then checks the sidecar, exact whole-bundle and whole-mirror
inventories, every support and mirror digest, checksums, an exactly regenerated
SBOM and provenance statement, and the version plus normalized Go build info
embedded in every archive. Passing it still reports
`publicationReady: false`: artifact signing/transparency-log review and a live
public-path gate are still required.

Before an approved external publication, run the read-only public-path gate:

```bash
bun run provider:release:prepublish -- --root /srv/takosumi-provider-candidates/1.1.0
```

It permits only the fixed `https://app.takosumi.com/opentofu/providers/`
origin (including redirects), caps response size and time, and requires the new
immutable version document to return `404`. A `200`, even with identical bytes,
means the version already exists and overwrite is forbidden. This command does
not sign, upload, mutate a registry, or publish anything, and still reports
`publicationReady: false` until the external signature/transparency approval
is represented by the approved registry workflow.

Publishing, signing, transparency-log submission, registry creation, and
production mirror activation are separate reviewed external operations. The
builder performs none of them. Before approval, verify signature/provenance,
pass `provider:compatibility:release-check`, run OpenTofu and supported
Terraform installation matrices, record external provider state/FQNs, and
confirm that the final aggregate network-mirror index contains both historical
and new immutable versions.

## Incident response

If an already versioned public path differs from its approved digest:

1. Stop the dashboard/Worker release; do not overwrite or purge toward either
   byte sequence.
2. Capture URL, headers, size, digest, serving region/time, lockfile/state
   references, and source/build provenance.
3. Quarantine every observed byte sequence and classify affected consumers.
4. Publish a corrected build only under a new version after clean-tag,
   deterministic-build, SBOM, provenance, and install proof.
5. Keep the old bytes available for supported read/refresh/migration paths and
   document any state/lockfile migration explicitly.
