# TASK-0118 Phase 5 review follow-ups

- Repository / owner: Takosumi only; branch
  `fix/retired-dependency-followups-20261028`, based on merged #635 (`5c96fd74c`).
  No sibling repository or other worktree changes.
- Scope: refuse retired dependency consumers before compatibility work; explain
  operator data maintenance for all plans including destroy/uninstall; continue
  independent RunGroup members while persisting per-Capsule retirement failures;
  control export version 3; remove obsolete wording and unused dependency helpers.
- Independent review follow-ups: classify retired dependencies as a permanent
  scheduled-uninstall refusal, and show recorded refused Capsules in the
  RunGroup dashboard instead of an empty member list.
- Persisted contract: new RunGroup graph JSON may include per-Capsule
  `dependency_retired` failures without creating a blocked member PlanRun. Old
  group graphs remain readable. No database schema change or automatic row
  deletion. Historical Run / dependency snapshot authority stays fail-closed.
- Data maintenance: the self-host operator runbook provides read-only detection
  and ID/Workspace/consumer-scoped DELETE statements for D1 and Postgres, backup,
  postconditions and recovery. This task only documents them; no database,
  Cloudflare, staging or production operations are authorized or performed.
- Validation: regression RED for early refusal and RunGroup isolation, focused
  clean-environment Bun tests, then the repository portable gate. Independently
  review source/SQL boundaries before final candidate publication.
- Delivery: normal commit/push, one PR against main, watch `check and test` until
  green. No merge or deploy. Fetch origin and integrate concurrent main changes
  with ordinary merges, repeat checks as required.
- Reversal: revert this code commit. New graph failure records remain historical;
  replay does not resurrect a retired PlanRun. Older control export consumers
  must recognize version 3; this repository has no control bundle importer.
