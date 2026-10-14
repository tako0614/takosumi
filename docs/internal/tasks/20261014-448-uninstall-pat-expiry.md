# Issue #448: uninstall PAT deadline admission

- Owner/repository: Takosumi担当-pat-followup, `tako0614/takosumi` only.
- Baseline: waited for #443 at five-minute intervals; observed MERGED at
  `2026-10-14T00:56:35Z`. Its merge commit and freshly fetched `origin/main`
  were `eff82c3715e51eca290eb10ba6ea7d409c9fb38a`.
- Worktree: `/root/dev/takos/.worktrees/takosumi-uninstall-pat-expiry-20261014`;
  branch `fix/takosumi-uninstall-pat-expiry-20261014`.
- Decision: refuse new PAT reservations that Accounts cannot confirm at their
  deadline. A PAT expiring at or before `scheduledDestroyAt` cannot authorize
  finalization; warning alone would persist a predictably blocked reservation.
  This follows #443's OAuth admission refusal and its QA follow-up.
- Authority: Core owns the one candidate deadline; Accounts re-reads the exact
  PAT by nonsecret ID and checks account, grant, write scope, Workspace, revoke
  and strict expiry (`expiresAt > deadline`). A separate future-time port avoids
  silently reusing a current-time-only host validator. Missing port, false, or
  lookup exception refuses with 409 `capsule_uninstall_pat_deadline_unverified`
  before Capsule/Activity mutation, without backend exception text.
- Scope: shared Core scheduling admission, Core bootstrap, Node and Worker host
  composition, regression tests and ja/en scheduled-uninstall docs. Existing
  requester/grant schema, reservation rows and finalizer/Run reauthorization
  remain unchanged. Existing scheduled replay returns the same reservation.
- Session and unexpired/non-expiring PAT remain supported. Admission proves
  the known deadline only; actual provider dispatch may be later, and current
  authorization is still required at every finalization boundary.
- Verification: new focused tests reproduce the original 202 acceptance before
  implementation (1 pass / 7 fail). Node/Worker behavior tests exercise real
  Accounts stores; Memory/Postgres/D1 tests cover delayed expiry, immutable
  exact grant, cancellation and new-ID/full-grace rescheduling. Standalone
  Core/custom hosts without the new deadline port fail closed for PATs.
  Final focused suite: 179 pass / 0 fail, 10 files, with both environment
  variables unset and `--timeout 30000`. Independent design/code review found
  no blocking defect. Full `env -u NODE_ENV -u
  TAKOSUMI_ENVIRONMENT bun run check` results will be recorded in the PR.
- Delivery: Issue #448 -> ready PR -> formal QA comment matching full head SHA
  plus GHA green -> squash merge with `--match-head-commit`.
- Prohibited: production, deploy, force-push, takos1 and mutations to other
  worktrees. Staging publication belongs to stagingsync / merge watcher only.
