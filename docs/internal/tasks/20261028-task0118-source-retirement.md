# TASK-0118 Phase 2: app-owned Git Sources

- Scope: takosumi only. No DDL, deployment, or production data mutation in this task.
- Base: `origin/main` `b6f9bb5ba`; branch `feature/app-source-retirement-20261028`.
- Delivery order: retirement core and archive custody; lifecycle callers and daily recovery; one lane per owner; operator-only existing-data migration.
- Retirement stops admission first, waits for source sync work, deletes only owned source archives, then atomically removes snapshot/Source rows and records `source.retired`. Rows remain the retry work list until object deletion succeeds.
- Existing shared Sources must be split by an explicit dry-run-first operator migration. Normal reconciliation targets only `ownerCapsuleId`; no shared-Source compatibility path is retained.
- Phase 4 owns Interface links, install-attempt interface inputs, and installed-store state. This task avoids those areas.
- Validation: focused lifecycle/custody and memory/PostgreSQL/D1 parity tests and affected static phases locally; the complete portable gate runs in CI. The review-fix session must not run the local full gate or full suite because shared SSD capacity is limited; stop below 2 GB free. Operator migration fixtures include shared adopted snapshots and interrupted retries.
- External report: `/root/dev/tmp/tk0118/phase2-report.md`.

Implementation and verification are in progress.

## Independent review fixes (2026-10-28)

- Scope remains takosumi only, on PRs #646–#649. Merge `origin/main` normally; preserve Phase 4 Interface link revocation before Source retirement on every lifecycle path.
- Close initial Capsule claim admission atomically when the Source is disabled or has `retiringAt`. Preserve exact read-only replay.
- Bound archive cleanup and resume across invocations; perform one foreign-reference census per Source, retaining custody checks.
- Legacy ownerless retirement requires an operator mark after backup, dry-run and approval. Preserve ownerless live-app behavior until explicit backfill.
- No deployment, merge, external database access, or changes to capsule ownership/members, vault, OIDC, dashboard sharing or billing are authorized here.
- Review-fix report: `/root/dev/tmp/tk0118/phase2-fix-report.md`.
