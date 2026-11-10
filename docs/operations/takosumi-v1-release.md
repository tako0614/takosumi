# Takosumi OSS source release

This runbook covers immutable signed Git tags and GitHub source/module Releases.
The filename is retained for existing links; the procedure is not tied to v1 or v2.
It does not release a Hosted service, npm package, OCI image, desktop/mobile app,
or a Takoserver/provider runtime. Those are separate owning surfaces.

## Release shape

One stable software version consists of an annotated signed Git tag on one exact
reviewed main commit and a non-draft GitHub Release for that tag, without uploaded
assets. The root package stays private. Consumers use the tag or GitHub source
archive; the local quickstart builds its Runner from that checkout.

The operator owns instance configuration, storage, credentials and deployment.
Cloudflare Apply/Destroy still needs separately qualified digest authorities.
The Bun/PostgreSQL reference composition needs a separately integrated Runner.
OSS publication does not imply Hosted availability, capacity, billing or support.

## Prepare one candidate

Use the owning entrypoint to discover the surface without side effects:

```bash
bun run deploy -- --contract
```

The surface is `takosumi-oss-github-release`, targeting only `tako0614/takosumi`.
Its environment must explicitly be `production` because it creates public,
consumer-pinned identities. This does not authorize any production runtime change.

Before publication:

1. Finish source review and normal integration. Use one clean checkout of the
   exact current remote main commit; fetch only main with `git fetch --no-tags
   origin main`. Do not fetch/overwrite unrelated local provider tags.
2. Match the stable tag to the private root `package.json` version. Keep public
   notes at `docs/releases/<tag>.md` in that commit. Notes contain only public
   source references, no operator-private paths, keys or customer data.
3. Retain the existing successful main-push run of `.github/workflows/quality.yml`
   for that exact commit. The entrypoint verifies the repository, full commit,
   branch, event, workflow, conclusion and every required job through GitHub.
   It reuses that complete owner check; do not repeat full tests, build or docs
   at publication time. A PR run, older same-tree commit or caller-written
   attestation does not qualify the new exact main commit.
4. Independently review the release diff, security and Runner sandbox changes,
   backup limitations and rollback/upgrade guidance. Record the actual review
   outcome; do not invent human acceptance or actual-environment qualification.
5. Use the existing configured Git signing key and trusted verification setup.
   Do not create a new key/account. Both the local and remote selected tag and
   GitHub Release must be absent. An authentication/network failure does not
   establish absence. The entrypoint requires authenticated repository write
   access before interpreting a Release 404.

The root version and CHANGELOG are the software version; contract packages and
Runner artifacts have independent release identities. A successful candidate
Runner proof is not a published OCI image and is not a new prerequisite here.

## Publish through the owning entrypoint

The release owner makes the final publication decision after candidate checks
and independent review. Replace the two example values below with the exact
main SHA and its existing successful main quality run ID:

```bash
bun run deploy -- takosumi-oss-github-release publish \
  --environment production --tag v2.0.0 \
  --commit <full-main-commit> --ci-run <existing-main-quality-run-id>
```

This is the only publication entrypoint. It signs one local annotated tag,
verifies it, pushes that exact ref without force, fetches only that remote tag
and verifies the signed object/commit, creates the Release once with notes read
from the immutable Git commit, and checks the public Release identity. It never
rebuilds source, edits existing Releases, uploads assets, or invokes schema,
credential, provider, Hosted, npm, OCI or mobile publication helpers.

Retain stdout in operator-private storage. Its result identifies the source,
tag object, public URL, existing CI run and notes digest without exposing the
signing key or credentials. Private records do not belong in this repository.

## Failure, readback and forward repair

Preflight rejection leaves public targets untouched. Once signing or any
publication step is attempted, failure is `indeterminate` with its last stage;
inspect the exact identity rather than automatically retrying any mutation.
The local tag may already exist even if no remote publication happened.

```bash
bun run deploy -- takosumi-oss-github-release verify \
  --environment production --tag v2.0.0 \
  --commit <full-release-commit> --ci-run <existing-main-quality-run-id>
```

`verify` performs no tag/Release publication. It may fetch the selected tag into
`FETCH_HEAD` only, verifies the trusted signature and exact commit, and checks
Release tag/title/notes/non-draft state and the empty asset inventory.
The source identity is the signed tag header (`object`, `type commit`, internal
version name) and its exact commit. GitHub treats `target_commitish` as unused
when a tag already exists, so that metadata is not an identity guard.
It returns `published` only for a complete match, or a nonzero result for
`absent`, `tag-only`, unavailable or mismatched state. It can inspect an older
released main commit after main advances; it does not require rewriting refs.

Never move, force-update, delete or reuse a published tag/version. A partial
publication is not an automatic retry/resume permit. Halt promotion and let the
release owner decide forward repair through a new reviewed version. Runtime
rollback remains a separate operator action and must obey the upgrade cautions.

## Upgrade and backup cautions

Read [v2.0.0 notes](../releases/v2.0.0.md), the [CHANGELOG](../../CHANGELOG.md),
[backup/restore](./backup-restore-drills.md), [rollback](./rollback-sop.md), and
[generated secrets](./secret-rotation.md) before upgrading an existing instance.

The backup API is only a partial ledger export, with no importer. Failed
pre-destroy export does not prevent scheduled destruction. Operators must
independently back up and verify restore of all databases, objects and keys.
Existing migrations are forward-only; reverting an image does not undo data or
schema changes. Drain old execution contexts before accepting new-mode uninstall
reservations. Do not mix incompatible readers or roll back with new reservations
or generated-secret/manifest changes pending; use the documented forward repair.
Source publication itself performs no instance migration or drain.
