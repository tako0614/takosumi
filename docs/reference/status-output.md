# Status And Read Surfaces {#status-output}

The public Takosumi core API is write-oriented: dry-run, install, deploy
dry-run, deploy, and rollback. A compatible operator also provides a documented
read projection for the workflows that depend on history: dashboards, CLIs,
support tooling, rollback target selection, async apply polling, and audit
review.

The read projection is mandatory at the semantic level and operator-owned at the
route level. Each operator chooses its route inventory, authentication,
pagination, and account-plane projection shape, while preserving the minimum
fields below.

Minimum read projection:

| View                 | Minimum semantics                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Installation inspect | `id`, `spaceId`, `appId`, `status`, `currentDeploymentId`, created/update timestamps.              |
| Deployment list      | Deployments for one Installation, ordered by creation time, with pagination or bounded retention.  |
| Deployment inspect   | `id`, `installationId`, `source`, `manifestDigest`, `status`, public/non-secret `outputs`.         |
| Async polling        | A `running` Deployment can be observed until it becomes `succeeded` or `failed`.                   |
| Rollback eligibility | Whether a `succeeded` Deployment is retained and selectable as a rollback target.                  |
| Redaction            | Raw credentials, tokens, private keys, and provider secrets stay behind refs or operator controls. |

The reference kernel has internal read routes for operator tooling, but those
routes are reference implementation details. They are not part of the portable
Installer API contract, and they are not called with the public installer
bearer.

Takosumi Cloud, for example, exposes account-session / PAT protected
Installation list, inspect, event, launch, materialize, and export views as
Cloud account-plane API surface. Start from
[Takosumi Cloud](./takosumi-cloud.md) for that distribution.

## Related Pages

- [Installer API](./installer-api.md)
- [Takosumi Core Specification](./core-spec.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
