# Changelog

All notable user-visible changes to the Takosumi source/module release live here.
Takosumi is consumed in-process by the operator platform worker and the
self-hosted Takos distribution worker; there is no npm-published service package
for the v1 GA line.

## Unreleased — OpenTofu Capsule DAG Rebaseline

- Takosumi v1 public concepts are `Space`, `Source`, `Connection`,
  `Installation`, `Dependency`, `Run`, `RunGroup`, `Deployment`,
  `OutputSnapshot`, and `Activity`.
- Takosumi installs plain OpenTofu Module Capsules from Git repositories.
  Repository metadata comes from generic source information such as Git URL,
  commit, tag, Capsule path, and well-known OpenTofu outputs.
- The Deploy Control API creates Installations, runs `compatibility_check` /
  `plan` / `apply` / `destroy` flows, records approvals and policy decisions,
  and reads Deployments, OutputSnapshots, logs, and audit events.
- Plan runs return `planDigest`; apply verifies it with the pinned source,
  dependency snapshot, and plan artifact before execution.
- OpenTofu execution, provider credentials, state backend, resource limits,
  network policy, account plane, billing mode, OIDC, dashboard, and deploy
  facade wiring are operator responsibilities expressed through Connection /
  InstallationProviderConnection / policy and operator distribution configuration.
- Runner profiles, backend adapters, and runtime-agent implementation code are
  operator-selected implementation details, not source authoring vocabulary.
- Build, operator CLI, dashboard, and platform-worker release tasks are Bun-first.

## Pre-v1 Notes

Earlier pre-release notes were consolidated during the v1 rebaseline. The current
source of truth is the docs under `docs/reference/`, `CONVENTIONS.md`, and
package-level READMEs.
