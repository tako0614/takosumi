# TASK-0118 Phase 2: app-owned Git Sources

- Scope: takosumi only. No DDL, deployment, or production data mutation in this task.
- Base: `origin/main` `b6f9bb5ba`; branch `feature/app-source-retirement-20261028`.
- Delivery order: retirement core and archive custody; lifecycle callers and daily recovery; one lane per owner; operator-only existing-data migration.
- Retirement stops admission first, waits for source sync work, deletes only owned source archives, then atomically removes snapshot/Source rows and records `source.retired`. Rows remain the retry work list until object deletion succeeds.
- Existing shared Sources must be split by an explicit dry-run-first operator migration. Normal reconciliation targets only `ownerCapsuleId`; no shared-Source compatibility path is retained.
- Phase 4 owns Interface links, install-attempt interface inputs, and installed-store state. This task avoids those areas.
- Validation: focused lifecycle/custody and memory/PostgreSQL/D1 parity tests for each change; `bun run check` for the final candidate. Operator migration fixtures include shared adopted snapshots and interrupted retries.
- External report: `/root/dev/tmp/tk0118/phase2-report.md`.

Implementation and verification are in progress.

## Delivery

- Retirement core: PR #646. New sync admission fences active Source state in the same storage boundary; historical cross-Source archive references defer retirement until operator normalization.
- Lifecycle callers: PR #647. Discard, committed destroy and abandonment invoke retirement; the daily sweep bounds mutations and rotates candidates. Composed lifecycle and destroyed GET/list regressions pass.
- Adopted lane: PR #648. Owner/state CAS and owner-only reconciliation, adopted backups and path-aware update facts are covered by focused parity tests.
- Existing-data operator migration and final complete gate are still in progress. No production mutation has been executed.
