# Store API

Takosumi can use any TCS 2.0-compatible Store as a Capsule discovery surface.
The Store project, not Takosumi, owns the TCS wire contract. Consult the
[TCS 2.0 specification](https://github.com/tako0614/takosumi-store/blob/main/docs/SPEC-v2.md)
for canonical fields, routes, pagination, and error envelopes, and the
[Takosumi Store reference implementation](https://github.com/tako0614/takosumi-store)
for a working server. This page defines only Takosumi's integration boundary.

## Install handoff

The only install authority Takosumi accepts from a TCS 2.0 listing is its Git
repository URL. A suggested name and presentation metadata may initialize the
UI, but they do not select executable content.

1. The dashboard receives the listing's repository URL.
2. Takosumi syncs a Source from that repository root and pins its ref to an
   immutable commit.
3. Takosumi selects a module from the exact SourceSnapshot's
   [Repository manifest](./repository-manifest.md).
4. The server uniquely resolves a host policy override matching the repository
   URL. When none exists, it uses the generic Git InstallConfig and checks the
   exact module within that policy ceiling.
5. It persists the selected module path in a Workspace-scoped derived
   InstallConfig and continues through the ordinary review, Plan, and Apply flow.

A Store client cannot send `modulePath` or `installConfigId` when requesting
`compileInstallUx: true`. A single-module manifest selects its only module; a
multi-module manifest requires an exact `defaultModule` in
`takosumi.com/v2.1`. Missing candidates and missing defaults fail closed.
Multiple host overrides also fail closed; zero overrides use the generic host
policy, so installing an app does not require registering an app-specific
InstallConfig in the Store.
A host override is execution policy matched by `sourceSelector.url`; it does
not need `store` presentation metadata. Operator policy that permits lifecycle
or credential use therefore cannot surface as a second Store listing.

## Authority boundary

A Store listing and `.well-known/tcs.json` are discovery and presentation
metadata. They have no authority to:

- select a module path, ref, tag, commit, SourceSnapshot, or InstallConfig;
- declare inputs, secrets, credentials, providers, Interface grants, or
  lifecycle policy; or
- proxy, cache, merge, or override `.well-known/takosumi.json`.

Takosumi ignores any path retained by a legacy response or presentation
document when selecting a module. Switching Store nodes does not change the
authority of an existing Capsule, Source, InstallConfig, Plan, or Run.

## Third-party Stores

A third-party Store works by implementing the TCS 2.0 read contract; it does
not need Takosumi-specific install fields. Listing endpoints must be reachable
by the browser, and repository URLs remain subject to Takosumi's Source policy.
Authentication, moderation, and publishing belong to each Store and do not
grant Takosumi Workspace authority.
