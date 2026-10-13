# Issue #427: prepare locked VitePress dependencies

- Owner/repository: Takosumi only; branch
  `fix/takosumi-427-vitepress-deps-20261014`.
- Base: `1b08419c1` (`origin/main`, PR #428).
- Scope: remove implicit docs dependency installation from the hosted-docs
  build; refuse unprepared official-plan and routine-code builds before any
  build command; document `npm ci` against the existing docs lockfile.
- Release behavior: preparation becomes explicit. The canonical docs lockfile,
  deterministic two-build plan contract, hosted-docs asset sealing, source pin,
  and provider mutation mechanics stay unchanged.
- Verification: regression tests cover missing/non-executable VitePress and
  both staging/production seals. Focused and complete local CI results are
  recorded in the PR; the complete gate uses CI-pinned Bun 1.4.0 with `NODE_ENV`
  unset and dedicated E2E ports 24251/24252.
- Delivery: ordinary feature commit/push, draft PR closing #427, ready after
  a passing gate, then request quality/release QA. No merge.
- Excluded: staging/production plan, execute, publish, deploy, runner push,
  operator-private state, staging lock, publication journal, keys/PATs, other
  worktrees, and deckide terminal/deck changes. Staging publication remains
  owned by Takosumi担当-stagingsync.

## Focused verification

- Regression before the fix: 4 pass / 9 fail on Bun 1.4.0; the missing-dependency
  cases reached build commands and the shell case invoked the fake installer.
- Focused release/docs/composition suite after the fix: 48 pass / 0 fail.
- Actual deterministic builds: both staging and production matched their
  respective two-build seals, with 176 assets including 66 hosted-docs assets
  per environment (33.18 seconds total).
- Full-history vs depth-1 hosted-docs builds, each with its own locked npm
  install: all 66 assets matched, digest
  `sha256:d9f4fca101786f4c1a24b2885a18dc0a9a4ab006f10cd62f4f5273f3f46a9ab2`.
- Independent source review: no blocking findings. The self-host preparation
  command also includes dev dependencies explicitly.
