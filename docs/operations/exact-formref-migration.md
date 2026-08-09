# Exact FormRef migration (retained custody)

> This is an operator-only migration note for historical Resource rows. It is
> not a current Form authoring, package installation, or activation procedure.

The supported product flow is a Git/OpenTofu/Terraform Stack. An operator may
still need to retain an exact identity while observing or deleting an old
Resource/Run/state row. Preserve the complete `FormRef` (`apiVersion`, `kind`,
`definitionVersion`, `schemaDigest`) beside its immutable `packageDigest`; do
not derive either value from `latest`, kind alone, or caller-selected Space.

For the retained portable identity, use
`forms.takoform.com/v1alpha1` and the exact package evidence produced by
Takoform or the external Host. The old Resource wire-to-FormRef mapping remains
migration data; it grants no current Host authority. Historical package evidence alone does not approve a Form,
activate it, create an Offering, or select a TargetPool.

## Safe migration posture

- Work only with an authenticated operator/control-plane identity and an
  explicit Workspace-to-Space mapping.
- Inventory all candidate rows independently, page with bounded cursors, and
  bind the inventory digest to an immutable pre-write backup.
- Dry-run first; write only exact pairs with idempotent evidence and refuse
  substitutions or concurrent changes.
- Verify Resource/lock identity and observe/delete behavior after each bounded
  page; never invoke a new provider or hosted Form lifecycle as part of the
  migration.
- Keep package/definition bytes and digests in operator-private evidence and
  prove an isolated backup/restore replay before touching production state.

The legacy route is normally `404`. With
`TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1`, authenticated list/read/events/
observe/delete and TargetPool/SpacePolicy `GET`/`HEAD`/`DELETE` are available;
discovery and all writes remain unavailable (`404`/`410`).
