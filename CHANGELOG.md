# Changelog

All notable user-visible changes to the published Takosumi package live here.
The current package is the single npm stream `@takosjp/takosumi`.

## Unreleased — OpenTofu-native v1 Rebaseline

- Takosumi v1 public concepts are `Installation`, `Deployment`, `PlanRun`,
  `ApplyRun`, `RunnerProfile`, and `DeploymentOutput`.
- Takosumi deploys plain OpenTofu module repositories. Repository metadata comes
  from generic source information such as Git URL, commit, tag, module path, and
  well-known OpenTofu outputs.
- The Deploy Control API creates/imports Installations, creates PlanRuns,
  records approvals and policy decisions, creates ApplyRuns, and reads
  Deployments, DeploymentOutputs, logs, and audit events.
- Plan runs return `planDigest`; apply can pass it through
  `expected.planDigest` to guard the reviewed source and plan artifact.
- OpenTofu execution, provider credentials, state backend, resource limits,
  network policy, account plane, billing, OIDC, dashboard, and deploy facade
  wiring are operator responsibilities expressed through RunnerProfiles and
  operator distribution configuration.
- Backend adapters and runtime-agent implementation code are operator-selected
  implementation details, not a Takosumi package split or public source
  authoring vocabulary.
- Build and npm publication tasks are Bun-first.

## Pre-v1 Notes

Earlier pre-release notes were consolidated during the v1 rebaseline. The current
source of truth is the docs under `docs/reference/`, `CONVENTIONS.md`, and
package-level READMEs.
