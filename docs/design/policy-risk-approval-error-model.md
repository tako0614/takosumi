# Policy, Risk, Approval, and Error Model

Policy turns Space, snapshot, and effect data into allow, deny, or approval decisions.

## Policy outcomes

```text
allow
deny
require-approval
```

## Effect model

Policy must evaluate both family and details.

```yaml
effectFamilies:
  - secret
  - grant
  - network

effectDetails:
  secret:
    projectionFamily: secret-env
    rawValueStoredInCore: false
    updateBehavior: restart-required
  grant:
    access: read-write
    target: takos.database.primary
    credentialTtlSeconds: 3600
  network:
    egress:
      - host: db.example.com
        protocol: tcp
        port: 5432
```


## Space policy gates

Policy must evaluate Space membership and Space export sharing.

```text
space-resolution:
  Is the actor allowed to deploy in this Space?

namespace-scope-resolution:
  Is the export visible inside this Space?

cross-space-link:
  Is there an explicit SpaceExportShare or operator-approved import?

space-secret-projection:
  May this Space receive the secret projection?

space-artifact-use:
  May this Space read the DataAsset?
```

Cross-space access is denied by default.

## Risk kinds

```text
secret-projection
external-export
generated-credential
generated-grant
network-egress
traffic-change
stale-export
revoked-export
cross-scope-link
cross-space-link
shadowed-namespace
space-export-share
implementation-unverified
actual-effects-overflow
rollback-revalidation-required
revoke-debt-created
raw-secret-literal
```

## Approval lifecycle

```text
pending
approved
denied
expired
invalidated
consumed
```

Approval binds to:

```yaml
Approval:
  spaceId: space:acme-prod
  desiredSnapshotDigest: sha256:...
  operationPlanDigest: sha256:...
  riskItemIds: []
  approvedEffects: {}
  effectDetailsDigest: sha256:...
  actor: ...
  policyVersion: ...
  expiresAt: ...
```

Invalidation occurs when any of these change:

- DesiredSnapshot digest
- OperationPlan digest
- effect details
- selected implementation
- external export freshness
- network egress
- grant access
- catalog release
- Space id, Space export share, or Space policy

## Error model

Every resolution or operation planning failure must return:

```yaml
Error:
  subject: link:api.DATABASE_URL
  reason: access-required
  candidates: []
  safeFix: []
  requiresPolicyReview: []
  operatorFix: []
```

Fix hints are classified. Access escalation, external links, and network expansion must not be presented as safe fixes.

## Policy packs

Operators should select from policy packs and override only differences.

```text
dev/open
selfhost/simple
prod/default
prod/strict
enterprise/catalog-approved-only
```
