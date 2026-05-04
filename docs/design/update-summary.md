# Update Summary

This update adds `Space` to the final abstract design and makes namespace isolation explicit.

Takosumi v1 is now:

```text
invariant-first
space-isolated
snapshot-backed
graph-shaped
write-ahead-operation-journaled
```

## Major Space additions

- Added `Space Model` as a first-class design document.
- Added Space to the root statement and root vocabulary.
- Space is not a manifest field; it is supplied by deploy context, actor auth, API path, operator context, or client profile.
- Every Deployment, snapshot, journal, observation, approval, debt, activation, and GroupHead belongs to exactly one Space.
- Namespace paths are Space-scoped.
- The same path in two Spaces is not the same export by default.
- Namespace resolution now uses a Space scope stack:
  deployment-local, generated, group, environment, space, operator-granted, external participant, explicit cross-space import.
- Reserved prefixes such as `takos`, `operator`, and `system` remain operator-controlled, but visibility is Space-scoped.
- Cross-space links are denied by default.
- Added `SpaceExportShare` for explicit cross-space export sharing.
- CatalogRelease visibility is assigned to Spaces through operator policy.
- Space carries policy pack, allowed catalog releases, namespace visibility, secret partition, artifact visibility, approvals, journals, observations, and GroupHead state.
- DataAssets, secrets, approvals, OperationJournal, ObservationSet, RevokeDebt, audit events, and ActivationSnapshot are Space-scoped.
- Production serialization now includes Space export sharing and CatalogRelease assignment.

## Final root sentence

Takosumi v1 turns a small manifest plus Space context into immutable snapshots, materializes object/export/link/exposure graphs through write-ahead operation journals, and manages reality through Space-scoped observation, debt, and activation records.
