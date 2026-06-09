# Control Plane API

Takosumi's control plane is an HTTP API that manages the OpenTofu Capsule DAG directly under a Space. The
canonical source is [`docs/core-spec.md`](../../core-spec.md): the public surface and external install link are defined
there, and the error codes are owned by the service contract. When this document conflicts with the spec, the spec wins.

The public vocabulary is **Space / Source / Connection / Provider Template / Provider Env Set /
OpenTofu Capsule / Capsule Normalizer / Compatibility Report / Capsule Gate / Installation / InstallConfig /
DeploymentProfile / ProviderBinding / Dependency / SourceSnapshot / DependencySnapshot / StateSnapshot / Run /
RunGroup / Deployment / OutputSnapshot / Backup / Billing / Activity**. Runner substrate / image / limits are
operator-internal execution details subordinate to Connections + ProviderBinding + the policy layers.

## Surfaces and auth model

The public control-plane surfaces are `/api/*`, `/install`, and the inbound webhook seam `/hooks/*`. Account-session
routes used by the dashboard and in-process seams used by accounts/CLI distributions are internal distribution paths,
not this API surface.

| Surface    | Purpose                  | Auth                                                                 |
| ---------- | ------------------------ | -------------------------------------------------------------------- |
| `/api/*`   | public control plane     | host-resolved scoped principal; reference fallback uses bearer token |
| `/install` | public install deep link | no bearer; hands off to the dashboard session gate                   |
| `/hooks/*` | inbound forge webhook    | hook secret, not operator bearer                                     |

### `/api` scoped principal

Every `/api` route is protected by a scoped principal resolved by the host worker. Dashboard sessions, accounts-plane
flows, and CLI bearer tokens are distribution-specific entry points; the API handler only sees an `actor` / `spaceIds` /
`operations` principal. The reference fallback sources the token from `TAKOSUMI_DEPLOY_CONTROL_TOKEN`; when neither the
token nor a bearer resolver is configured, the host hides the `/api` routes behind `404 not_found` so an unconfigured
surface is not exposed on a public host.

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

### `/hooks` webhook seam

`/hooks/*` is an inbound seam authenticated by the Source webhook secret. It is not an operator-bearer route; it is a
public ingress for queueing source sync. The hook secret is returned once at creation time and is not included in normal
Source read responses.

### Internal session / CLI paths

Some hosted or self-host distributions route dashboard and operator CLI calls through account sessions or an in-process
fetch seam before delegating to the public operations. Those paths are distribution internals. The contract for external
integrations, Capsule authors, and public API readers is only `/api/*`, `/install`, and `/hooks/*`.

## `/api` surface

No version prefix is used; everything is mounted under `/api`. `/api` routes are protected by the host-resolved scoped
principal, with bearer token support only as the reference fallback. Operator-only admin routes require an
operator-scoped principal.

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
| GET    | `/api/sources?spaceId={spaceId}`    | List Sources in a Space (never includes the hook secret)                                                                    |
| GET    | `/api/sources/{sourceId}`           | Read a Source                                                                                                               |
| POST   | `/api/sources/{sourceId}/sync`      | Create a `source_sync` Run resolving the default ref to an archive snapshot                                                 |
| GET    | `/api/sources/{sourceId}/snapshots` | List immutable archive snapshots for a Source (commit / digest / R2_SOURCE key)                                             |

`POST /hooks/sources/{sourceId}` is the inbound forge-webhook seam, authenticated by the hook secret rather than the
bearer.

### Connections

Connection creation uses thin subroutes that fix the kind / provider / authMethod. Credential `values` are write-only
and never appear in logs or responses. Bodies may carry a non-secret `expiresAt`; an expired Connection is marked
`expired`, and provider/source credential mint plus test fail closed.

| Method | Path                                         | Purpose                                                                                                |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| POST   | `/api/connections/source/https-token`        | Git source HTTPS-token Connection (optional username)                                                  |
| POST   | `/api/connections/source/ssh-key`            | Git source SSH-key Connection (`scopeHints.knownHostsEntry` required)                                  |
| POST   | `/api/connections/cloudflare/oauth/start`    | Start a Cloudflare OAuth helper flow. Returns an authorization URL and state on success                |
| GET    | `/api/connections/cloudflare/oauth/callback` | Complete a Cloudflare OAuth helper flow and create a write-only `provider_env_set` Connection          |
| POST   | `/api/connections/cloudflare/token`          | Cloudflare API-token Connection (optional account/zone scope)                                          |
| POST   | `/api/connections/aws/assume-role`           | AWS assume-role-capable Connection (`scopeHints.awsRoleArn` required; AWS env `values` are write-only) |
| POST   | `/api/connections/gcp/oauth/start`           | Start a Google Cloud OAuth helper flow. Returns an authorization URL and state on success              |
| GET    | `/api/connections/gcp/oauth/callback`        | Complete a Google Cloud OAuth helper flow and create a write-only `provider_env_set` Connection        |
| POST   | `/api/connections/gcp/impersonation`         | Create a write-only Connection for Google service-account impersonation                                |
| GET    | `/api/connections`                           | List Connections visible to the principal. Never includes secret values.                               |
| POST   | `/api/connections/{connectionId}/test`       | Verify stored credentials with the provider                                                            |
| POST   | `/api/connections/{connectionId}/revoke`     | Revoke a Connection and delete its sealed secret blob                                                  |
| PUT    | `/api/operator-connection-defaults`          | Operator-scoped bearer only. Set an instance-wide default Connection for a provider                    |
| GET    | `/api/operator-connection-defaults`          | Operator-scoped bearer only. List instance-wide default Connections                                    |

Operator default connections are instance-wide administration. The routes appear in the `/api` inventory, but only
operator-scoped principals can use this operator-only admin surface. Space / Installation APIs see them only through
ProviderBindings with `mode: "default"`.

### Providers

The Providers API is a read surface for provider templates. Users add provider credentials through
`Connection` provider env sets.

| Method | Path                          | Purpose                  |
| ------ | ----------------------------- | ------------------------ |
| GET    | `/api/providers`              | List Provider Templates  |
| GET    | `/api/providers/{providerId}` | Read a Provider Template |

Takosumi-managed hosted providers start Cloudflare-only. AWS / GCP / GitHub / Kubernetes / arbitrary providers use
Space-owned `provider_env_set` Connections. OAuth / AssumeRole / impersonation are helpers for creating or refreshing
env sets.

OAuth helpers are enabled by operator env. All helpers require `TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET`.
Cloudflare uses `TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID` / `TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET` /
`TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI` / `TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL` /
`TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL`. GCP uses `TAKOSUMI_GCP_OAUTH_CLIENT_ID` /
`TAKOSUMI_GCP_OAUTH_CLIENT_SECRET` / `TAKOSUMI_GCP_OAUTH_REDIRECT_URI`, with optional
`TAKOSUMI_GCP_OAUTH_AUTHORIZATION_URL` / `TAKOSUMI_GCP_OAUTH_TOKEN_URL` / `TAKOSUMI_GCP_OAUTH_SCOPES` overrides.

### Installations + InstallConfigs

| Method | Path                                     | Purpose                                                                                                                   |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/install-configs`                   | List official / Space-scoped InstallConfigs                                                                               |
| GET    | `/api/install-configs/{installConfigId}` | Fetch an InstallConfig                                                                                                    |
| POST   | `/api/spaces/{spaceId}/installations`    | Create an Installation under a Space from a Source + InstallConfig. The `environment` is part of the execution namespace. |
| GET    | `/api/spaces/{spaceId}/installations`    | List a Space's Installations                                                                                              |
| GET    | `/api/installations/{installationId}`    | Read an Installation                                                                                                      |
| PATCH  | `/api/installations/{installationId}`    | Safely patch Installation status (`active` / `stale` / `error` only; destroy states stay owned by the destroy flow)       |
| DELETE | `/api/installations/{installationId}`    | Create a destroy-plan Run instead of deleting directly; approval + destroy_apply performs teardown                        |

### Deploy / Upload

This is the default `takosumi deploy` path: deploy a local working directory directly without registering a git Source
(the `wrangler deploy` analogue). The CLI packs the local Capsule into a `tar` (zstd) archive, sends it to the upload
route, the worker stores it in R2_SOURCE and records an **upload-origin SourceSnapshot**, then the deploy route pins
that snapshot, resolves or creates the Installation, and starts a plan Run. The heavy work (Capsule Gate / plan / apply)
runs inside the runner container with vault-minted, per-phase credentials; the request never carries credential
material.

| Method | Path                            | Purpose                                                                                                            |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/spaces/{spaceId}/uploads` | Ingest a local Capsule `tar`(zstd) archive as a binary body; store it in R2_SOURCE and record an upload-origin SourceSnapshot |
| POST   | `/api/deploy`                   | Pin the upload snapshot, resolve or create the `@space/name` Installation, and start a plan Run                   |

`POST /api/spaces/{spaceId}/uploads` takes **archive bytes** as the request body, not JSON (a binary ingest the
JSON-schema OpenAPI inventory does not model). The Capsule path is passed via the optional `?path=` query (default `.`).
The archive is capped at 64 MiB; an empty body is `400 invalid_argument` and an oversized one is `413`. A host without
`writeSourceArchive` (R2_SOURCE) wired returns `501 not_implemented`.

```txt
POST /api/spaces/{spaceId}/uploads?path=deploy
Content-Type: application/octet-stream
<tar.zst archive bytes>

-> 201 { "snapshot": SourceSnapshot }   # origin: "upload", sourceId absent
```

`POST /api/deploy` pins the upload snapshot, resolves or creates the Installation, and starts a plan Run. `vars` becomes
the InstallConfig variable mapping (string values only; secret material never travels here — providers bind through
Connections). If `snapshotId` is not an upload-origin snapshot, or belongs to another Space, the call fails with
`invalid_argument`. If the existing Installation is already bound to a git Source, the call fails with
`failed_precondition`, steering you to deploy through that Source instead.

```json
POST /api/deploy
{
  "spaceId": "space_...",
  "name": "my-app",
  "environment": "production",
  "snapshotId": "snap_...",
  "vars": { "region": "apac" },
  "planOnly": false,
  "autoApprove": false
}
```

```json
{
  "installation": { "id": "inst_...", "name": "my-app", "...": "..." },
  "installConfigId": "icfg_...",
  "run": { "id": "run_...", "type": "plan", "...": "..." },
  "created": true
}
```

`environment` defaults to `"production"` when omitted, and `created` is `true` when this `deploy` call created the
Installation. On first deploy it synthesizes a default InstallConfig (trust `space`, backend rewrite / provider lift /
alias injection allowed, empty output allowlist). Because the origin is `upload`, **no Source row is required and
`Installation.sourceId` is absent**; everything downstream (Capsule Gate / plan / apply / DAG) flows through the same
origin-agnostic pipeline. The CLI polls the returned `run` and reads the OutputSnapshot on success.

### Capsule compatibility

This route family is the public Capsule compatibility API route. A Compatibility Report is a canonical Takosumi core
concept; in the API it is the report resource that stores the Normalizer / Gate result for a SourceSnapshot.
The order is: `Capsule Normalizer creates a Compatibility Report draft -> Capsule Gate evaluates it before credential
mint -> Takosumi finalizes the Compatibility Report with Gate findings`.

| Method | Path                                          | Purpose                                                                     |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/api/sources/{sourceId}/compatibility-check` | Pin a SourceSnapshot and run Normalizer / Gate without provider credentials |
| GET    | `/api/compatibility-reports/{reportId}`       | Read a CapsuleCompatibilityReport                                           |

### Dependencies

| Method | Path                                               | Purpose                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/installations/{installationId}/dependencies` | Create a Dependency edge whose consumer is this Installation. Mode is `variable_injection` / `remote_state` / `published_output`; `remote_state` is same-Space trusted dependency, cross-Space flows through OutputShare. Cycles are rejected |
| GET    | `/api/installations/{installationId}/dependencies` | List Dependencies (asProducer / asConsumer views)                                                                                                                                                                                             |
| DELETE | `/api/dependencies/{dependencyId}`                 | Delete a Dependency edge (gated by the consumer's Space permission)                                                                                                                                                                           |

### Runs

| Method | Path                                               | Purpose                                                                                                        |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/installations/{installationId}/plan`         | Installation-driven plan Run (resolves the latest SourceSnapshot and dispatches with installation state scope) |
| POST   | `/api/installations/{installationId}/drift-check`  | Read-only drift-check Run (cannot be applied and never waits for approval)                                     |
| POST   | `/api/installations/{installationId}/destroy-plan` | destroy-plan Run (always lands `waiting_approval`)                                                             |
| GET    | `/api/runs/{runId}`                                | Unified Run ledger projection                                                                                  |
| GET    | `/api/runs/{runId}/logs`                           | Structured diagnostics + run-level audit trail (redacted)                                                      |
| GET    | `/api/runs/{runId}/events`                         | Run-level audit-event trail                                                                                    |
| POST   | `/api/runs/{runId}/approve`                        | Approve a waiting-approval Run (destroy / destructive change), clearing the apply gate                         |
| POST   | `/api/runs/{runId}/cancel`                         | Cancel a queued or waiting-approval Run                                                                        |

Run type is `source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` / `destroy_apply` /
`drift_check` / `backup` / `restore`.

### Run groups

| Method | Path                                   | Purpose                                                                                               |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST   | `/api/spaces/{spaceId}/plan-update`    | Create a `space_update` RunGroup (re-plan every stale Installation + downstream in topological order) |
| POST   | `/api/spaces/{spaceId}/drift-check`    | Create a `space_drift_check` RunGroup (one read-only drift_check Run per active Installation)         |
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
| POST   | `/api/output-shares/{shareId}/approve` | Receiving Space acceptance flow                                                                |
| POST   | `/api/output-shares/{shareId}/revoke`  | Revoke an OutputShare (permission-gated on the granting `fromSpaceId`)                         |

A sensitive entry (`outputs[].sensitive: true`) requires `sensitivePolicy.allow === true` and a non-empty `reason`, and
the host-injected resolver must confirm the encrypted raw output artifact contains that output with `sensitive: true`.
OutputShare responses and Activity events return only output names, aliases, and sensitive flags, never values.

### Activity

Activity is the Space-scoped audit projection. It returns only the public-safe newest-first event stream the dashboard
can render, not raw audit payloads or secret literals.

| Method | Path                             | Purpose                                        |
| ------ | -------------------------------- | ---------------------------------------------- |
| GET    | `/api/spaces/{spaceId}/activity` | List a Space's Activity events (`limit` aware) |

### Billing

Billing is the Space-scoped public surface. Implementation conformance is tracked in
[`core-conformance.md`](../../core-conformance.md).
The `GET /billing` plan projection includes typed `BillingPlanLimits`, and plan completion evaluates the active
subscription's `maxEstimatedCreditsPerRun` / `quota`. `enforce` blocks an over-limit run before reservation, while
`showback` records audit evidence and continues.

| Method | Path                                        | Purpose                                                   |
| ------ | ------------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/spaces/{spaceId}/billing`             | Space billing mode / plan / credit balance projection     |
| GET    | `/api/spaces/{spaceId}/credit-reservations` | Space credit reservations                                 |
| POST   | `/api/spaces/{spaceId}/credits/top-up`      | Credit top-up through the hosted/operator billing adapter |
| GET    | `/api/spaces/{spaceId}/usage`               | Space usage events                                        |
| POST   | `/api/spaces/{spaceId}/subscription/change` | Plan changes through the hosted/operator billing adapter  |

### Backups

Backups expose the Space ledger control backup and the service-data backup archive for Installations that opt in.

| Method | Path                                          | Purpose                                                           |
| ------ | --------------------------------------------- | ----------------------------------------------------------------- |
| POST   | `/api/installations/{installationId}/backups` | Resolve the Installation and create a backup for its owning Space |
| POST   | `/api/spaces/{spaceId}/backups`               | Create a backup for the Space                                     |
| GET    | `/api/spaces/{spaceId}/backups`               | List a Space's backup ledger pointers newest-first                |

### Implementation extensions

The following routes are implementation extensions. External integrations should not depend on them.

| Method | Path                      | Treatment                                                |
| ------ | ------------------------- | -------------------------------------------------------- |
| PATCH  | `/api/sources/{sourceId}` | Operator/dashboard extension for Source metadata updates |

## 501 surfaces

MVP public routes return authenticated `501 not_implemented` when an optional service or helper driver is not wired.

- OutputShare routes: only when `outputSharesService` is unwired
- Activity route: only when `activityService` is unwired
- Cloudflare OAuth / GCP OAuth helper routes: only when the helper driver is unwired. Helpers create
  `provider_env_set` Connections and are not a third credential source.
- Backup routes: only when `backupsService` / the R2*BACKUPS artifact store is unwired. The canonical layout is
  `control.json.zst.enc` / `state.tar.zst.enc` / `artifacts.manifest.json` / `service-data.tar.zst.enc`.
  `service-data.tar.zst.enc` is produced from the isolated Runner Container `backup` action, a provider snapshot adapter,
  or a projected export artifact from `BackupConfig.outputPath`. `custom_command` runs credential-free inside the
  restored SourceSnapshot. `provider_snapshot` prefers the Runner Container's provider-scoped adapter command
  (`TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND*<SAFE_PROVIDER>`) over the generic command. The control backup path itself does
  not fetch provider data or execute arbitrary commands.

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
