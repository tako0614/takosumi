# P0 local-substrate approval record (FIXTURE)

**This is NOT a real approval record.** It is a deterministic file the local-substrate uses to satisfy the `TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF` requirement of the hosted Takosumi access gate. The gate insists the approval ref must differ from the evidence ref (`p0-local-evidence.md`); this file exists solely to be a distinct second pointer.

Real launch approval records live outside the OSS repo in the operator evidence store, currently `takosumi-private/evidence/...`, with a human reviewer's sign-off, audit trail, and immutable evidence refs. This fixture satisfies only the local-substrate gate, never production.

## Why the gate requires distinct refs

Conflating "evidence I reviewed" and "approval I granted" defeats the purpose of the hosted Takosumi access gate — a reviewer could approve their own evidence without a second human in the loop. Even in this fixture file, the lesson is preserved: the two paths point at different files so the gate code can be exercised end-to-end.

## Local-substrate scope

The local worker is reachable only from the docker network (`prove-no-public-leak.sh` enforces this). No user traffic is served by the local worker, so the fixture approval is acceptable for local smoke runs. Production deploys must use non-fixture operator evidence refs, matching readiness digests, and a public readiness summary; these local fixture refs are not production evidence.
