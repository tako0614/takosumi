# Historical provider compatibility authority

These digest-pinned files exist only to migrate or recover state created by the
discontinued Takosumi provider. They contain no Terraform state, credential,
runtime value, or private signing material.

- `1.0.0-state-identity.json` binds the structural schema read from the exact
  quarantined public 1.0.0 bytes.
- `1.1.4-delta-policy.json` records the cancelled unpublished source snapshot;
  it is not a candidate or release authority.
- `service-form-removal-policy.json` requires at least 365 non-retroactive days,
  a 90-day external zero-usage observation, live migration evidence, and a
  restore drill before legacy state aliases/source can be removed.
- `service-form-migration-fixture-authority.json` pins Takoform migration
  fixtures without copying portable provider state into Takosumi.

The optional `provider:custody:state-proof` command checks old-state no-op,
observe, migration, rollback, and destroy using a retained local quarantine
mirror and disposable state. It is custody evidence only. Publication remains
permanently disabled regardless of proof outcome.

`service-form:compat-removal:check` validates the repo policy and deliberately
reports removal ineligible. Operator evidence may eventually make the separate
v2+ removal decision eligible; it cannot reactivate this provider.
