# Account-Plane Profile {#operator-account-plane-profile}

This profile is the Cloud-compatible account layer surface. Takosumi core
manages Source / Installation / Deployment / Installer API records, while
Takosumi manages account behavior.

## Profile Surfaces

| Surface | Cloud definition |
| --- | --- |
| PlatformService inventory | Space-visible identity, billing, runtime, storage, and other capabilities |
| Deploy facade | account/admin workflow brokering approved Installer API calls |
| Account API | sessions, PATs, Space ownership, projections, events, export/import, dashboard |
| OIDC | issuer, upstream identity, per-Installation clients, key rotation |
| Billing | owner records, portal, usage reporting, metering authorization |
| Projection ledger | account-facing projection of core Installation / Deployment state |

Credentials are not reused across families. Public responses and export bundles
carry refs or public fields instead of raw secret values.
