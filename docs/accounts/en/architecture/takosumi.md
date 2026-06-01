# Takosumi Architecture {#takosumi-architecture}

Takosumi composes Takosumi core with account/operator implementation.

| Component | Responsibility |
| --- | --- |
| Takosumi core | Source guards, Installation / Deployment, Installer API |
| Takosumi Accounts | account sessions, OIDC, billing, projection ledger, launch token, facade |
| Dashboard | UI over Accounts API and projection records |
| Provider/runtime adapters | PlatformService materialization and provider evidence |

Cloud checks auth, policy, billing, and approval, calls Installer API, then
records account-facing projections and events.
