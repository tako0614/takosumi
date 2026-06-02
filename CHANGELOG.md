# Changelog

All notable user-visible changes to the published Takosumi package live here.
The current package is the single npm stream `@takosjp/takosumi`.

## Unreleased — Manifestless v1 Rebaseline

- Takosumi v1 public concepts are Source / Installation / Deployment /
  PlatformService, with `InstallPlan` as a dry-run response snapshot.
- Takosumi no longer requires or documents a Takosumi-specific source metadata file.
  Repository metadata comes from generic source information such as Git URL,
  commit, tag, and `package.json`.
- The Installer API remains the five `/v1/installations*` endpoints.
- Dry-run returns `planSnapshotDigest`; apply can pass it through
  `expected.planSnapshotDigest` to guard reviewed source and binding resolution.
- Terraform/OpenTofu, provider credentials, account plane, billing, OIDC,
  dashboard, deploy facade, and PlatformService inventory are operator
  distribution responsibilities.
- Reference backend adapters and runtime-agent connectors live in the sibling
  `operator implementation` single package and are optional implementation pieces, not
  public Source authoring vocabulary.
- Build and npm publication tasks are Bun-first.

## Historical Release Notes

Earlier pre-release notes were consolidated during the v1 rebaseline. The
current source of truth is the docs under `docs/reference/`, `CONVENTIONS.md`,
and package-level READMEs.
