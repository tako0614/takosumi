# P0 local-substrate readiness evidence (FIXTURE)

**This is NOT a real launch evidence document.** It exists solely as a deterministic file whose SHA-256 the local-substrate test bed can hash into `TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST` so the hosted Takosumi access gate accepts the local worker as "approved" for testing purposes. Real launch evidence lives outside the OSS repo in the operator evidence store, currently `takosumi-private/evidence/...`, and is paired with the public readiness summary consumed by the production-hardening workflow. Those records are human reviewed and pinned by immutable evidence refs, not by this mutable local fixture.

## What this file replaces

Before this file existed, the local-substrate set:

```
TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST=\
    sha256(b"local-substrate-readiness-v1")
```

That string was hard-coded in two places (env file + a comment) and did not correspond to anything reviewable. The digest was "evidence" in name only.

## What the local-substrate uses this for

The cloud worker's hosted Takosumi access policy (`takosumi/worker/src/handler.ts::parsePlatformAccess`) expects:

| env var                                                  | meaning                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS`                      | `open` / `closed` access status users see at sign-in time                                                  |
| `TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST`            | sha256 of the evidence file the operator reviewed                                                          |
| `TAKOSUMI_ACCOUNTS_PLATFORM_EVIDENCE_REF`                | commit-pinned `git+<repo>@<sha>#<path>` pointer to the evidence file                                       |
| `TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF`                | commit-pinned `git+<repo>@<sha>#<path>` pointer to the approval record                                     |
| `TAKOSUMI_PRODUCTION_HARDENING_GATE`                     | `enforce` when hosted Takosumi access is open                                                              |
| `TAKOSUMI_*_EVIDENCE_REF` / `TAKOSUMI_*_EVIDENCE_DIGEST` | commit-pinned local fixture refs for container, egress, credential recipe, and secret-boundary smoke checks |

In production these must be set to non-fixture values pulled from the operator's launch checklist and validated by the production-hardening evidence workflow. In local-substrate we want the same code path to be exercised end-to-end (so the gate logic itself is smoke-tested), but the refs can point at local fixture files because the local worker is never user-reachable (`prove-no-public-leak.sh` keeps it on the docker network only).

## How to regenerate the digest

```bash
cd takosumi/deploy/local-substrate
sha256sum docs/launch-readiness/p0-local-evidence.md
# → <hash>  docs/launch-readiness/p0-local-evidence.md
# Then update TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST and the
# local hardening *_EVIDENCE_DIGEST values in env/takosumi-service-worker.env
# with `sha256:<hash>`.
```

The substrate's `scripts/up.sh` does NOT auto-recompute this digest — that's intentional, because the whole point of pinning a digest is that the operator chose it deliberately at the moment they reviewed the file. If you change this file you must also update the env file by hand; otherwise the worker's hosted Takosumi access gate will refuse with `readiness_digest_mismatch`.
