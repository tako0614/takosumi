# D1 coordinator generation recovery

- Owner/repository: Takosumi; branch
  `fix/d1-coordinator-generation-integer-20261014`, based on `63eb47c24e`.
- Defect: D1 binds JavaScript numbers as SQL reals in `json_set`. Interrupted
  install/revision claims retain JSON generation `1.0` alongside physical
  integer `1`, and the next claim refuses an expired lease.
- Scope: cast new JSON generation writes to integer; accept retained JSON
  integer-valued reals only when they exactly equal the physical integer
  generation. Preserve lease, CAS, phase, Workspace identity and epoch fences.
  No schema migration or bulk data rewrite; successful claims normalize only
  their own row.
- Verification: isolated workerd D1 regressions for install and revision,
  fresh and retained-real rows, lease expiry, busy/stale claims, wrong epoch,
  stale completion and successful resumed completion. Run focused tests then
  `env -u NODE_ENV TAKOSUMI_E2E_PORT=26521 TAKOSUMI_DOCS_BROWSER_PORT=26522 bun run check`.
- Release order: ready PR, green GHA and explicit quality/release approval on
  the unchanged head, head-matched squash merge, serialized official staging
  publication once, then recovery tests on newly created disposable fixtures.
- Authority: staging only; never touch production, takos1, existing Workspaces
  or existing fixture data. Do not force-push or print credentials.
- Reversal: restore the previous sealed platform version if schema-compatible;
  this patch adds no schema migration. A rollback would restore the reclaim
  defect for interrupted rows; retain diagnostics for forward repair.
- Failure: stop on publication failure without blind retry and record whether
  the staging target was touched. Approval timeout leaves the PR unmerged.

Private operator evidence and results stay outside the repository.

## Local validation

- Regression before the fix: 0 pass, 4 fail on isolated workerd D1; after the
  fix: 4 pass, 0 fail. Existing install-plan store parity: 11 pass, 0 fail.
- The exact full-gate command above passed all phases through both TypeScript
  checks. Workerd tests passed 52/52; the subsequent suite reported 5,734 pass,
  2 fail, 5 skip. Unchanged Runner ownership and local v2 Core tests failed in
  the suite and passed on isolated file reruns (10/10 and 1/1 respectively).
- All remaining gate phases were executed separately. Dashboard build passed;
  browser tests reported 41 pass, 1 fail, 2 skip, and the unchanged chunk-load
  recovery test passed its isolated rerun. Docs browser passed 3/3; the Worker
  schema-bundle build passed. The initial canonical gate is recorded as failed,
  rather than relabeled green based on the isolated reruns.
- Independent technical review found no blocking issue. This does not replace
  the requested quality/release approval or same-head green GitHub Actions.
