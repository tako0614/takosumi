# Issue #431: remove unused git from the app-docs Docker stage

- Owner/repository: Takosumi only; branch
  `chore/remove-app-docs-git-20261014`.
- Base: `752ddc45c9e42fdf31ebad812f6a16984b56bef7` (`origin/main`, PR #430).
- Scope: remove the stale lastUpdated comment and git-only apt-get block from
  `deploy/node-postgres/Dockerfile`. Preserve the tracked docs npm lockfile,
  hosted-docs build script, and dashboard docs overlay.
- Build behavior: the app-docs stage no longer installs git. Hosted-docs asset
  bytes and their release seal must match the original stage without `.git`.
- Verification: original/changed Docker app-docs builds and asset/seal comparison;
  full node-postgres image build and embedded docs HTTP serving; focused existing
  contracts; complete `env -u NODE_ENV TAKOSUMI_E2E_PORT=26421
  TAKOSUMI_DOCS_BROWSER_PORT=26422 bun run check`. Results and tested HEAD are
  recorded in the PR.
- Delivery: ordinary feature push, ready PR closing #431, then request explicit
  quality/release QA. Squash merge only with green GitHub CI and explicit
  quality/release approval.
- Excluded: reference docs config, source pins, main/force pushes, staging or
  production publication, credentials/data, takos1, and other worktrees.
  Staging publication remains owned by Takosumi担当-stagingsync.

## Focused evidence

- Existing self-host, static-asset, and hosted-docs contracts: 28 pass / 0 fail
  on Bun 1.4.0. The first invocation had one transient import-graph resolution
  failure; the unchanged suite passed on rerun.
- Original and changed app-docs stages both build without `.git`; the changed
  stage also has no git executable. All 66 assets and the canonical seal match:
  `sha256:d9f4fca101786f4c1a24b2885a18dc0a9a4ab006f10cd62f4f5273f3f46a9ab2`.
- Both full node-postgres images build. Disposable PostgreSQL/server proofs
  return healthy status and serve all 66 docs assets with exact original bytes.
  `/docs/index.html`, `/docs/en/index.html`, and `/docs/endpoints.html` serve docs.
- Existing navigation limitation: `/docs/`, `/docs/en/`, and `/docs/endpoints`
  serve the dashboard fallback in both original and changed images. This issue
  does not modify static routing; the PR requests QA follow-up.
- Disposable proof containers and their network were removed. Complete gate
  results and the exact tested commit are recorded in the PR after this ledger.
