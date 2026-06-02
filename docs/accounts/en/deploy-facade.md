# Deploy Facade {#deploy-facade}

The Takosumi Accounts deploy facade is a Takosumi account management / admin API surface. It is not workload output data or a platform service path.

The facade brokers approved calls to the Takosumi Installer API:

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

## Boundary

| Surface                            | Managed by                     |
| ---------------------------------- | ------------------------------ |
| Installer API endpoint contract    | Takosumi                  |
| account authorization              | Takosumi                 |
| approval / budget / billing policy | Takosumi                 |
| dashboard or admin workflow        | Takosumi                 |
| upstream Takosumi credential       | operator-private configuration |

## Approval Envelope

Mutating facade requests carry Cloud-only confirmation:

```json
{
  "source": {},
  "expected": {},
  "confirm": {
    "approvalDigest": "sha256:...",
    "costAck": true
  }
}
```

`source` and `expected` are forwarded using the Takosumi Installer API contract. `confirm.*` is consumed by Cloud and is not manifest or Takosumi Installer API surface.

`approvalDigest` must match the reviewed operation, Installation, app id, next source, requested bindings, and policy/cost impact. Metered or paid changes require `confirm.costAck: true`.

The upstream Takosumi token is never returned to browser clients, export bundles, Deployment outputs, or workload runtime data.
