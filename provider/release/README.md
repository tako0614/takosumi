# Discontinued provider custody

This directory is a historical custody record, not a release lane.

- `version.json` records the cancelled, unpublished `1.1.4` source snapshot as
  `status: discontinued`, `publishable: false`, with new versions forbidden.
- `registry.json` retains only the quarantined public `1.0.0` observation. It
  has no approved version and therefore admits no Takosumi mirror artifacts.
- `quarantine/1.0.0.json` preserves the exact public metadata/archive evidence.
  The binary reported `dev` and modified VCS provenance, so it must never be
  rebuilt, overwritten, or republished.
- `failures/1.1.0.json` through `1.1.3.json` preserve immutable failed/cancelled
  attempts. Tags and evidence are never moved or reused.
- `compatibility/` preserves value-free schema identity, the cancelled 1.1.4
  delta, and the 365-day state-removal policy.
- `keys/` and `trust/` are retained public verification material only. They no
  longer authorize a workflow because provider publication is disabled and the
  publication workflow is absent.

`bun run provider:custody:check` verifies every JSON digest sidecar, the exact
historical set, the absence of the release workflow and active release package
scripts, and the empty default mirror admission set. Go tests continue to keep
the retained migration source buildable; neither check is a provider release
or a Takosumi GA publication prerequisite.

Portable Service Forms and their Resource Interface descriptors belong to
Takoform. Capsule Interfaces use service-side InstallConfig blueprints.
Takosumi operator objects are managed through Takosumi API/CLI/dashboard.
