# Takosumi v1 release

This runbook covers the Takosumi OSS source/module release. The current
supported product is one Git/OpenTofu/Terraform Stack flow with arbitrary
providers and generic Interfaces. It does not publish a generic Offering
authority, Takosumi Form Host, Form Registry, FormActivation, TargetPool, or
SpacePolicy surface. Existing Offering routes/stores are legacy/operator-only
implementation conformance gaps and removal-target migration custody. Managed
service Offering, capacity, provider credentials, and Host execution belong to
Takoserver; Takosumi Hosted retail/commercial readiness is a separate external
product decision. Takosumi Cloud is a retired historical identity.

This procedure is evidence and failure handling, not release authorization.
The release owner stops at the first missing, stale, mutable, or unreviewed
item.

## Release shape

A release consists of:

- one immutable signed Git tag on an exact reviewed commit;
- one GitHub Release for that tag; and
- one private receipt binding the commit, checks, approvals, and readback.

Takosumi is consumed as source modules composed into an operator host. Do not
publish an npm service package, duplicate platform bundle, or generated Cloud
application artifact from this repository. A Cloud deployment records its own
immutable revision and the exact OSS commit it composes.

## Candidate gates

Before signing, use a fresh worktree and require:

1. clean status and exact `origin/main` candidate;
2. an unreused tag/release name and a verified signing key;
3. the protected workflow result for that exact commit;
4. `bun run check`, focused tests, docs build, and `git diff --check` passing;
5. security, runner-sandbox, rollback, and backup/restore reviews with human
   acceptance; and
6. release notes checked for secrets, customer identifiers, private paths,
   provider account data, and unsupported availability claims.

The current contract gate is [Core Spec](../internal/core-spec.md), with
conformance evidence in [Core Conformance](../internal/core-conformance.md).
Historical `final-plan.md` or Form Host runbooks are not release authority.

```bash
set -euo pipefail

TAG=v1.0.0
git fetch --prune origin main --tags
test -z "$(git status --porcelain)"
CANDIDATE="$(git rev-parse HEAD)"
test "$CANDIDATE" = "$(git rev-parse origin/main)"
REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/${TAG}" "refs/tags/${TAG}^{}")"
test -z "$REMOTE_TAG"
test "$(bun -e 'console.log(require("./package.json").version)')" = "${TAG#v}"
git config --get user.signingkey >/dev/null

bun install --frozen-lockfile
bun run check
bun test
bun run test:scripts
bun run docs:build:all
git diff --exit-code
git diff --check
```

A failed network/authentication check is an abort, not proof that a tag or
release is absent. Generated or formatted diffs require a reviewed fix and a
new candidate.

## Private receipt and publication

Create a private receipt containing the candidate SHA, protected workflow URL,
check results, security/rollback approvals, release-note digest, and explicit
`go`/`no-go`. Never copy tokens, raw Outputs, provider credentials, customer
data, or private operator paths into the repository or public release.

Only after the receipt says `go`:

```bash
git tag -s "$TAG" "$CANDIDATE" -m "Takosumi $TAG"
git verify-tag "$TAG"
test "$(git rev-list -n 1 "$TAG")" = "$CANDIDATE"
git push origin "refs/tags/$TAG"

gh release create "$TAG" --verify-tag \
  --title "Takosumi $TAG" --notes-file "$PUBLIC_RELEASE_NOTES"
```

Never move, delete, force-update, or reuse a published tag. Fix defects
forward through a new patch release.

## Independent readback and reversal

Fetch the tag from the remote, verify its signature and resolved commit, and
read the GitHub Release as non-draft. Record those immutable URLs in the
receipt. If a composed host was deployed, its owner performs separate
authenticated smoke/readback against that host and records its deployment
revision; OSS publication does not imply Takoserver managed capacity, provider
credentials, Offering availability, or Takosumi Hosted retail, billing, SLA, or
support readiness.

Before publication, abort on any failed gate, missing approval, evidence drift,
or candidate mismatch. After publication, keep the tag immutable; stop
promotion, roll the composed host to its prior revision when possible, repair
through protected `main`, and issue a new signed patch release.
