# Operational Hardening Checklist

## Space isolation

- [ ] Every Deployment, snapshot, journal, observation, approval, debt,
      activation, and GroupHead has a Space id.
- [ ] Manifest does not declare Space; Space comes from deploy context / auth /
      API / operator profile.
- [ ] Namespace paths are Space-scoped.
- [ ] Secrets, artifacts, journals, approvals, observations, and audit events
      are Space-scoped.
- [ ] Reserved prefixes are operator-controlled and granted into Spaces.
- [ ] GroupHead identity is `spaceId + groupId`.

## Root invariants

- [ ] ResolutionSnapshot and DesiredSnapshot are immutable.
- [ ] Apply uses recorded snapshots, not live descriptor URLs or live namespace
      registry.
- [ ] All graph entities have stable addresses.
- [ ] Lifecycle class restricts operation kinds.
- [ ] Raw secret values are not stored in core canonical state.
- [ ] Actual effects cannot exceed approved effects without pause / compensation
      / approval.
- [ ] Side-effecting operations are write-ahead journaled.
- [ ] Generated object ids are deterministic where possible.
- [ ] Apply and activation are separated.
- [ ] Observations do not mutate desired state.
- [ ] External source objects are not destroyed by deployment destroy.
- [ ] Production serializes critical mutations, Space export sharing, and
      CatalogRelease assignment.

## Catalog

- [ ] CatalogRelease has atomic registry digests including Space registry and
      Space policy digests.
- [ ] CatalogRelease is assigned to Spaces explicitly.
- [ ] Public targets are catalog aliases.
- [ ] Descriptor documents are normalized before runtime use.
- [ ] Input schemas are pinned.

## Namespace exports

- [ ] Namespace path grammar is enforced inside each Space.
- [ ] Shadowing is policy-gated, and production denies meaningful Space /
      operator / external shadowing by default.
- [ ] Default exports never imply admin access.
- [ ] Grant-producing exports require explicit access unless safe default is
      declared.
- [ ] ExportDeclaration and ExportMaterial are separated.

## Journal and recovery

- [ ] Operation intent is recorded before external calls.
- [ ] Generated object planned records are written before creation.
- [ ] External call start and observed handle are both journaled.
- [ ] RevokeDebt is created for failed cleanup.
- [ ] Journal entries with unresolved debt are not compacted away.

## Policy and approval

- [ ] Approvals bind to snapshot digest, operation plan digest, and effect
      details.
- [ ] Approval invalidation triggers are implemented per the closed v1 set in
      [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md).
- [ ] Plan risks have stable risk ids and only emit kinds drawn from the closed
      v1 Risk enum.
- [ ] Error hints are classified as safeFix, requiresPolicyReview, or
      operatorFix.

## Secrets

- [ ] Secret exports cannot project to plain env.
- [ ] Literal env secret scanning or policy is enabled.
- [ ] Runtime secrets are not passed to transforms by default.

## Activation

- [ ] Ingress reservation and traffic assignment are separated.
- [ ] GroupHead update is serialized per Space.
- [ ] Rollback modes are explicit.

## Observability

- [ ] Audit events include catalog release, resolution, desired adoption, link
      selection, operation stages, generated objects, debts, approvals,
      activation, and GroupHead.
- [ ] RevokeDebt is visible in status and readiness checks.
