# Control Plane API

Takosumi's control plane is an HTTP API that manages the OpenTofu Capsule DAG directly under a Space. The
canonical source is [`docs/core-spec.md`](../../core-spec.md): the public surface and external install link are defined
there, and the error codes are owned by
the contract (`takosumi-contract/deploy-control-api`). When this document conflicts with the spec, the spec wins.

The public vocabulary is **Space / Source / Connection / OpenTofu Capsule / Installation (+InstallConfig) / Dependency /
Run / RunGroup / Deployment / OutputSnapshot / Billing / Activity**. Runner substrate / image / limits are internal
execution profile details subordinate to Connections + CapabilityBinding + the policy layers.

## Surfaces and auth model

The public control-plane surfaces are `/api/*` and `/install`. Account-session routes used by the dashboard and
in-process seams used by accounts/CLI distributions are internal distribution paths, not this API surface.

| Surface    | Purpose                  | Auth                                                    |
| ---------- | ------------------------ | ------------------------------------------------------- |
| `/api/*`   | public control plane     | operator bearer token (`Authorization: Bearer <token>`) |
| `/install` | public install deep link | no bearer; hands off to the dashboard session gate      |

### `/api` operator bearer

Every `/api` route is protected by a bearer token. The reference fallback sources the token from
`TAKOSUMI_DEPLOY_CONTROL_TOKEN`; when neither the token nor a bearer resolver is configured, the host hides the `/api`
routes behind `404 not_found` so an unconfigured surface is not exposed on a public host.

Operators and account-planes can replace the bearer resolver with a scoped principal carrying `actor` / `spaceIds` /
`operations`. Scopes are **default-deny**: omitted scopes grant no access.

- Reads are authorized by the target record's `spaceId`.
- Mutations are authorized by `operations` (`create` / `update` / `destroy` …).
- Space creation, operator-scope Connections, and operator connection defaults are instance-wide, so only the
  unrestricted bearer (`spaceIds: "*"`) may touch them.
- Calling `GET /api/connections` without `spaceId` lists operator-scope Connections and is likewise unrestricted-bearer
  only.

Out-of-scope requests return `403 permission_denied`, and the `actor` is recorded on API-originated audit events. The
default fallback bearer is a principal with `spaceIds` / `operations` set to `"*"`.

### Internal session / CLI paths

Some hosted or self-host distributions route dashboard and operator CLI calls through account sessions or an in-process
fetch seam before delegating to the public operations. Those paths are distribution internals. The contract for external
integrations, Capsule authors, and public API readers is only `/api/*` and `/install`.

## `/api` surface

No version prefix is used; everything is mounted under `/api`. All routes use
operator bearer auth.

### Spaces

| Method | Path                    | Purpose                                                               |
| ------ | ----------------------- | --------------------------------------------------------------------- |
| POST   | `/api/spaces`           | Create a Space (`@handle` owner namespace). Unrestricted bearer only. |
| GET    | `/api/spaces`           | List Spaces visible to the principal                                  |
| GET    | `/api/spaces/{spaceId}` | Read a Space                                                          |
| PATCH  | `/api/spaces/{spaceId}` | Update a Space (MVP: `displayName` only)                              |

### Sources

| Method | Path                                | Purpose                                                                                                                     |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/sources`                      | Register a git Source (URL-policy checked; ls-remote verification is a queued `source_sync`). Returns the hook secret once. |
| GET    | `/api/sources`                      | List Sources visible to the principal (never includes the hook secret)                                                      |
| GET    | `/api/sources/{sourceId}`           | Read a Source                                                                                                               |
| POST   | `/api/sources/{sourceId}/sync`      | Create a `source_sync` Run resolving the default ref to an archive snapshot                                                 |

`POST /hooks/sources/{sourceId}` is the inbound forge-webhook seam, authenticated by the hook secret rather than the
bearer.

### Connections

Connection creation uses thin subroutes that fix the kind / provider / authMethod. Credential `values` are write-only
and never appear in logs or responses.

| Method | Path                                     | Purpose                                                                                                                                       |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/connections/source/https-token`    | Git source HTTPS-token Connection (optional username)                                                                                         |
| POST   | `/api/connections/source/ssh-key`        | Git source SSH-key Connection (`scopeHints.knownHostsEntry` required)                                                                         |
| POST   | `/api/connections/cloudflare/token`      | Cloudflare API-token Connection (optional account/zone scope)                                                                                 |
| POST   | `/api/connections/aws/assume-role`       | AWS assume-role-capable Connection (`scopeHints.awsRoleArn` required; AWS env `values` are write-only)                                        |
| GET    | `/api/connections`                       | List Connections visible to the principal. Never includes secret values.                                                                   |
| POST   | `/api/connections/{connectionId}/test`   | Verify stored credentials with the provider                                                                                                   |
| POST   | `/api/connections/{connectionId}/revoke` | Revoke a Connection and delete its sealed secret blob                                                                                         |

Operator default connections are instance-wide administration. If an implementation exposes routes for them, those routes
are operator-only implementation extensions, not the public Capsule install surface. Installations see them only through
CapabilityBindings with `mode: "default"`.

### Installations + InstallConfigs

| Method | Path                                  | Purpose                                                                                                                   |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/spaces/{spaceId}/installations` | Create an Installation under a Space from a Source + InstallConfig. The `environment` is part of the execution namespace. |
| GET    | `/api/spaces/{spaceId}/installations` | List a Space's Installations                                                                                              |
| GET    | `/api/installations/{installationId}` | Read an Installation                                                                                                      |
| PATCH  | `/api/installations/{installationId}` | Safely patch Installation status (`active` / `stale` / `error` only; destroy states stay owned by the destroy flow)       |
| DELETE | `/api/installations/{installationId}` | Create a destroy-plan Run instead of deleting directly; approval + destroy_apply performs teardown                        |

### Capsule compatibility

This route family is the public Capsule compatibility surface. A Compatibility Report stores the Normalizer / Gate
result for a SourceSnapshot.

| Method | Path                                          | Purpose                                                                     |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/api/sources/{sourceId}/compatibility-check` | Pin a SourceSnapshot and run Normalizer / Gate without provider credentials |
| GET    | `/api/compatibility-reports/{reportId}`       | Read a CapsuleCompatibilityReport                                           |

### Dependencies

| Method | Path                                               | Purpose                                                                                                           |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/installations/{installationId}/dependencies` | Create a Dependency edge whose consumer is this Installation (same-Space / `variable_injection`; cycles rejected) |
| GET    | `/api/installations/{installationId}/dependencies` | List Dependencies (asProducer / asConsumer views)                                                                 |
| DELETE | `/api/dependencies/{dependencyId}`                 | Delete a Dependency edge (gated by the consumer's Space permission)                                               |

### Runs

| Method | Path                                               | Purpose                                                                                                        |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/installations/{installationId}/plan`         | Installation-driven plan Run (resolves the latest SourceSnapshot and dispatches with installation state scope) |
| POST   | `/api/installations/{installationId}/destroy-plan` | destroy-plan Run (always lands `waiting_approval`)                                                             |
| GET    | `/api/runs/{runId}`                                | Unified Run projection (across the source_sync / plan / apply ledgers)                                         |
| GET    | `/api/runs/{runId}/logs`                           | Structured diagnostics + run-level audit trail (redacted)                                                      |
| GET    | `/api/runs/{runId}/events`                         | Run-level audit-event trail                                                                                    |
| POST   | `/api/runs/{runId}/approve`                        | Approve a waiting-approval Run (destroy / destructive change), clearing the apply gate                         |
| POST   | `/api/runs/{runId}/cancel`                         | Cancel a queued or waiting-approval Run                                                                        |

### Run groups

| Method | Path                                   | Purpose                                                                                               |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST   | `/api/spaces/{spaceId}/plan-update`    | Create a `space_update` RunGroup (re-plan every stale Installation + downstream in topological order) |
| GET    | `/api/run-groups/{runGroupId}`         | Read a RunGroup with its member Runs and computed status                                              |
| POST   | `/api/run-groups/{runGroupId}/approve` | Approve every waiting-approval member Run                                                             |

### Deployments

| Method | Path                                              | Purpose                                                                                                      |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/installations/{installationId}/deployments` | List an Installation's Deployments                                                                           |
| GET    | `/api/deployments/{deploymentId}`                 | Read a Deployment ledger record                                                                              |
| POST   | `/api/deployments/{deploymentId}/rollback-plan`   | Create a rollback plan Run pinned to that Deployment's source snapshot (flows through normal approval/apply) |

### Output shares

| Method | Path                                   | Purpose                                                                                        |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| POST   | `/api/output-shares`                   | Create a cross-Space OutputShare as `pending` (permission-gated on the granting `fromSpaceId`) |
| GET    | `/api/output-shares?spaceId=`          | List OutputShares granted or received by a Space                                               |
| POST   | `/api/output-shares/{shareId}/revoke`  | Revoke an OutputShare (permission-gated on the granting `fromSpaceId`)                         |

A sensitive entry (`outputs[].sensitive: true`) requires `sensitivePolicy.allow === true` and a non-empty `reason`, and
the host-injected resolver must confirm the encrypted raw output artifact contains that output with `sensitive: true`.
OutputShare responses and Activity events return only output names, aliases, and sensitive flags, never values.

If a hosted/operator distribution implements `POST /api/output-shares/{shareId}/approve`, it is an extension for the
receiving Space's acceptance flow. The canonical route list keeps OutputShare public operations to create / list / revoke.

### Billing

Billing is the Space-scoped public surface. Implementation conformance is tracked in
[`core-conformance.md`](../../core-conformance.md).

| Method | Path                                            | Purpose                                                   |
| ------ | ----------------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/spaces/{spaceId}/billing`                 | Space billing mode / plan / credit balance projection     |
| POST   | `/api/spaces/{spaceId}/credits/top-up`          | Credit top-up through the hosted/operator billing adapter |
| GET    | `/api/spaces/{spaceId}/usage`                   | Space usage events                                        |
| POST   | `/api/spaces/{spaceId}/subscription/change` | Plan changes through the hosted/operator billing adapter |

### Implementation extensions

The following routes may exist in an implementation, but they are not part of the canonical API list pasted into the spec.
External integrations should not depend on them.

| Method | Path                                    | Treatment                                                |
| ------ | --------------------------------------- | -------------------------------------------------------- |
| PATCH  | `/api/sources/{sourceId}`               | Operator/dashboard extension for Source metadata updates |
| GET    | `/api/sources/{sourceId}/snapshots`     | SourceSnapshot debug/list extension                      |
| GET    | `/api/install-configs?spaceId=`         | Catalog/admin extension; internal input to install flow  |
| GET    | `/api/spaces/{spaceId}/activity?limit=` | Activity projection extension; never returns values or secrets |
| GET/PUT | `/api/operator-connection-defaults`      | Operator-only defaults management extension              |

## 501 surfaces

No permanent `501 not_implemented` remains on the implemented MVP public routes. Implemented routes return `501
not_implemented` only when the host omits an optional service.

- OutputShare routes: only when `outputSharesService` is unwired
- Backup routes: only when `backupsService` / the R2_BACKUPS artifact store is unwired. Control backups are stored as
  `control.json.gz.enc`; the service-data MVP stores projected output pointers from
  `BackupConfig.mode = artifact_export` as a sealed `service-data-artifacts.json.gz.enc` manifest.
  `provider_snapshot` / `custom_command` are recorded as `unsupported` in that manifest.

The AWS assume-role route is a Connection-registration surface. STS short-lived credential vending conformance is
tracked in [`core-conformance.md`](../../core-conformance.md).

## Error envelope

Every error returns the same envelope. `requestId` is inherited from `x-request-id` / `x-correlation-id` (UUID / ULID
shape) or freshly minted when absent.

```json
{
  "error": {
    "code": "failed_precondition",
    "message": "expected.planDigest does not match plan run",
    "requestId": "req_...",
    "details": {}
  }
}
```

| Code                  | HTTP | Meaning                                              |
| --------------------- | ---- | ---------------------------------------------------- |
| `invalid_argument`    | 400  | Malformed body / param / query (incl. unknown_field) |
| `unauthenticated`     | 401  | Missing / mismatched bearer                          |
| `permission_denied`   | 403  | Out of scope (default deny)                          |
| `not_found`           | 404  | Record absent, or surface disabled                   |
| `failed_precondition` | 409  | Guard / generation mismatch                          |
| `resource_exhausted`  | 413  | Body exceeds the 1 MiB limit                         |
| `not_implemented`     | 501  | The 501 surfaces above                               |
| `internal_error`      | 500  | Unclassified server error                            |

## External install link

External sites pass a Git URL to deep-link into the install flow. The platform worker (accounts handler) parses and
URL-policy-checks the link, then 302s into the dashboard's Install OpenTofu Capsule flow (no bearer; the session gate is on the
dashboard side).

```txt
GET /install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
GET /install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
```

`source=` is a Terraform/OpenTofu module address (`git::https://...//path?ref=`); the short form uses separate `git` /
`ref` / `path` queries. The public `/install` deep link accepts only `https://` Git URLs, rejects embedded
credentials, and rejects literal private / loopback / metadata IP hosts. The Source registration API can handle Git
Sources using `https://`, `ssh://`, or scp-like `git@host:path/repo.git`, but external install links are limited to
browser-safe HTTPS.
