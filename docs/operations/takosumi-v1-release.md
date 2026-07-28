# Takosumi v1.0.0 Release

> Fail-closed procedure for the Takosumi OSS source/module release. This
> runbook prepares and publishes a signed `v1.0.0` source tag and GitHub
> Release only after the software and jointly advertised Cloud GA gates are
> complete.

| Field         | Value                  |
| ------------- | ---------------------- |
| Last reviewed | 2026-07-28             |
| Owner         | Takosumi release owner |
| Release       | `v1.0.0`               |
| Repository    | `tako0614/takosumi`    |

## Release shape

Takosumi is consumed as source modules composed into an operator host. The v1
release therefore consists of:

- one immutable, signed Git tag pointing at an exact `main` commit;
- one non-draft GitHub Release for that existing tag; and
- one release receipt containing public-safe check and approval references.

Do not publish an npm service package, build a duplicate platform bundle, run
the standard-form runtime artifact workflow, or attach generated application
artifacts to this release. Dashboard assets and host bundles are built by the
selected composition. Takosumi Cloud deployment is a separate immutable
deployment revision that must record the exact Takosumi commit/tag it composes.

This runbook does not authorize a release by itself. Stop at the first missing,
stale, mutable, or unreviewed item.

## Required state

Before creating the tag, all of the following must be true:

1. The candidate is the clean, exact `origin/main` commit and
   `package.json` reports `1.0.0`.
2. Remote tag `v1.0.0` and a GitHub Release with that name do not already
   exist.
3. The required `check and test` branch-protection check succeeded for the
   exact candidate SHA. Local reproduction also passes.
4. Every required software-GA row in
   [Core Conformance](../internal/core-conformance.md) and the
   [Final Plan GA Contract](../internal/final-plan.md#14-ga-contract) is complete
   for the exact candidate. An `optional gap` may remain only when its
   capability is excluded from the v1 contract.
5. Operator evidence validates the exact composed production-hardening
   registry. Release-activation evidence is also complete when that optional
   materializer is enabled.
6. The threat-model and runner-sandbox reviews have recorded human acceptance.
   Repository tests cannot populate those acceptance fields.
7. The release owner has a tested rollback target and the staging rollback
   rehearsal required by [Rollback SOP](./rollback-sop.md).
8. The jointly advertised Takosumi Cloud GA set has an approved, immutable
   production evidence receipt for this exact OSS candidate. A successful OSS
   build does not imply Cloud price, billing, isolation, recovery, SLA, or
   support readiness.
9. Release notes have been reviewed for secret values, customer identifiers,
   private paths, provider account ids, payment ids, mutable evidence links,
   and unsupported availability claims.
10. The release workstation can create and locally verify a signed Git tag.
    Signing configuration must name an approved release key; never copy a
    private key into the repository or evidence.

## Clean candidate preflight

Use a fresh release worktree or clone. Do not release from a dirty development
checkout.

```bash
set -euo pipefail

REPOSITORY=tako0614/takosumi
TAG=v1.0.0

git fetch --prune origin main --tags
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"

CANDIDATE="$(git rev-parse HEAD)"
test "$(bun -e 'console.log(require("./package.json").version)')" = "${TAG#v}"

REMOTE_TAG="$(
  git ls-remote --tags origin "refs/tags/${TAG}" "refs/tags/${TAG}^{}"
)"
test -z "$REMOTE_TAG"

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  echo "release already exists: $TAG" >&2
  exit 1
fi

git config --get user.signingkey >/dev/null
SIGNING_FORMAT="$(git config --get gpg.format || printf 'openpgp\n')"
case "$SIGNING_FORMAT" in
  openpgp | ssh | x509) ;;
  *) echo "unsupported signing format: $SIGNING_FORMAT" >&2; exit 1 ;;
esac
```

An existing tag or release is an abort, not a retry target. A failed
`git ls-remote` is also an abort; do not interpret a network/authentication
failure as tag absence. An unset `gpg.format` means Git's `openpgp` default;
the configured key and its verification trust must still be tested before
continuing.

Confirm the protected workflow result for the exact SHA:

```bash
gh run list \
  --repo "$REPOSITORY" \
  --workflow quality.yml \
  --commit "$CANDIDATE" \
  --limit 10 \
  --json headSha,status,conclusion,url
```

Continue only when an entry for `CANDIDATE` is completed with conclusion
`success`. Save its immutable run URL in the release receipt.

## Reproduce the public software gates

Use the locked toolchain versions from
[`.github/workflows/quality.yml`](../../.github/workflows/quality.yml). Run in
the same clean candidate checkout:

```bash
set -euo pipefail

bun install --frozen-lockfile
(cd dashboard && bun install --frozen-lockfile)
(cd docs && npm ci)
(cd website && npm ci)

(cd provider && go run golang.org/x/vuln/cmd/govulncheck@v1.6.0 ./...)
bun audit
(cd dashboard && bun audit)
bun run audit:public-sites

bun run check
bun test
bun run test:scripts
bun run docs:build:all
bun run website:build
git diff --exit-code
git diff --check
```

Any generated or formatted diff means the candidate is not reproducible.
Commit a reviewed fix through the normal protected `main` flow, then restart
this procedure on the new SHA.

When the production composition declares hardening contributions, validate the
exact private manifest and live gate response with the public validators. Keep
paths and bearer material outside the repository:

```bash
bun run production-hardening:evidence -- \
  "$OPERATOR_EVIDENCE_ROOT/evidence/production-hardening.json" \
  --contribution "$OPERATOR_HARDENING_CONTRIBUTION"

bun run production-hardening:gates -- \
  "$OPERATOR_EVIDENCE_ROOT/evidence/production-hardening.json" \
  --url "$OPERATOR_ORIGIN/internal/platform/hardening-gates" \
  --contribution "$OPERATOR_HARDENING_CONTRIBUTION" \
  --evidence-root "$OPERATOR_EVIDENCE_ROOT" \
  --require-enforced
```

Omit `--contribution` only when the composed registry is exactly the OSS
baseline. If release activation is enabled, also run:

```bash
bun run release-activation:evidence -- \
  "$OPERATOR_EVIDENCE_ROOT/evidence/release-activation.json" \
  --evidence-root "$OPERATOR_EVIDENCE_ROOT"
```

These commands validate evidence structure and live enforcement. The release
owner must still review the underlying threat model, isolation, rollback,
backup/restore, and Cloud commercial evidence for the same candidate.

## Candidate receipt and go/no-go

Create an operator-private receipt before signing. It must contain:

- candidate commit and expected tag;
- exact protected-workflow URL and local command results;
- conformance and readiness manifest digests;
- immutable Cloud deployment candidate/revision and live-smoke references;
- rollback revision, rehearsal reference, and recovery time;
- release-note digest;
- release owner plus required security, operations, and Cloud approvals; and
- explicit `go` or `no-go`, timestamp, and expiry/revalidation policy.

Do not copy tokens, raw logs, raw Outputs, private configuration, customer data,
provider account ids, or payment processor ids into the repository or public
release. Missing, expired, candidate-mismatched, or `no-go` evidence stops the
release.

## Sign and publish

Only after the receipt records `go`, create the tag on the exact candidate:

```bash
set -euo pipefail

test "$(git rev-parse HEAD)" = "$CANDIDATE"
test -z "$(git status --porcelain)"

git tag -s "$TAG" "$CANDIDATE" -m "Takosumi ${TAG}"
git verify-tag "$TAG"
test "$(git rev-list -n 1 "$TAG")" = "$CANDIDATE"

git push origin "refs/tags/${TAG}"
```

Prepare public release notes from `CHANGELOG.md`, including the supported
contract, compatibility posture, known non-GA capabilities, upgrade notes, and
rollback/forward-fix policy. Then create the release from the existing tag:

```bash
gh release create "$TAG" \
  --repo "$REPOSITORY" \
  --verify-tag \
  --title "Takosumi ${TAG}" \
  --notes-file "$PUBLIC_RELEASE_NOTES"
```

Do not create or move a floating `v1` tag as part of this procedure. Do not
force-update, delete, or reuse `v1.0.0`. A defect after publication is fixed
forward under a new patch version.

## Public readback

The release is not complete until independent readback proves the exact tag,
signature, commit, and non-draft release:

```bash
git fetch origin --tags
git verify-tag "$TAG"
test "$(git rev-list -n 1 "$TAG")" = "$CANDIDATE"

git ls-remote --tags origin "refs/tags/${TAG}" "refs/tags/${TAG}^{}"
gh release view "$TAG" \
  --repo "$REPOSITORY" \
  --json tagName,isDraft,isPrerelease,publishedAt,url
```

Record the public tag/ref result, verified signature identity, resolved commit,
and GitHub Release URL in the private receipt. Then deploy or promote the Cloud
composition using that exact tag/commit and record the immutable deployment
revision. Re-run the authenticated production smoke and commercial readiness
readback before announcing GA.

## Abort and rollback rules

Abort before tagging on any failed check, missing approval, evidence drift,
unavailable dependency, signing failure, or mismatch between candidate,
receipt, tag, and Cloud composition.

After the tag is public, never roll the tag back. If the GitHub Release was
created with incorrect public text but no code defect, amend only the text with
reviewed provenance and record the change. For a code or contract defect:

1. stop GA promotion and customer announcement;
2. roll the hosted composition back to its prior immutable deployment revision;
3. keep the signed tag and public release immutable;
4. fix through protected `main`; and
5. issue a new signed patch release after repeating this runbook.
