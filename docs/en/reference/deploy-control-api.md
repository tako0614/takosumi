# Control Plane API

Takosumi's control plane is an HTTP API that manages the OpenTofu Installation DAG directly under a Space. The
canonical source is [`docs/core-spec.md`](../../core-spec.md): the public surface is
[§30](../../core-spec.md#30-api), the external install link is
[§12](../../core-spec.md#12-external-install-link) / [§30](../../core-spec.md#30-api), and the error codes are owned by
the contract (`takosumi-contract/deploy-control-api`). When this document conflicts with the spec, the spec wins.

The public vocabulary is **Space / Source / Connection / Installation (+InstallConfig) / Dependency / Run / RunGroup /
Deployment / OutputSnapshot / Activity**. `PlanRun` / `ApplyRun` / `App` / `Environment` / `InstallProfile` /
`RunnerProfile` / `DeploymentOutput` are retired words and do not appear on the current surface (a run is a `Run` with a
`type`; outputs are `OutputSnapshot` / `outputsPublic`). RunnerProfile is no longer public vocabulary: it persists as an
internal execution profile (substrate / image / limits) subordinate to Connections + CapabilityBinding + the policy
layers.

## Surfaces and auth model

There are three surfaces, each with its own authentication.

| Surface | Purpose | Auth |
| --- | --- | --- |
| `/api/*` + `/install` | §30 public control plane | operator bearer token (`Authorization: Bearer <token>`) |
| `/v1/control/*` | dashboard SPA | account-plane session (operations facade pass-through) |
| `/v1/*` seam | accounts plane / CLI | in-process fetch seam (operator bearer) |

### `/api` operator bearer

Every `/api` route is protected by a bearer token. The reference fallback sources the token from
`TAKOSUMI_DEPLOY_CONTROL_TOKEN`; when neither the token nor a bearer resolver is configured, the host hides the `/api`
routes behind `404 not_found` so an unconfigured surface is not exposed on a public host.

Operators and account-planes can replace the bearer resolver with a scoped principal carrying `actor` / `spaceIds` /
`operations` / `runnerProfileIds`. Scopes are **default-deny**: omitted scopes grant no access.

- Reads are authorized by the target record's `spaceId`.
- Mutations are authorized by `operations` (`create` / `update` / `destroy` …) and `runnerProfileIds`.
- Space creation, operator-scope Connections, and operator connection defaults are instance-wide, so only the
  unrestricted bearer (`spaceIds: "*"`) may touch them.
- Calling `GET /api/connections` without `spaceId` lists operator-scope Connections and is likewise unrestricted-bearer
  only.

Out-of-scope requests return `403 permission_denied`, and the `actor` is recorded on API-originated audit events. The
default fallback bearer is a principal with `spaceIds` / `operations` / `runnerProfileIds` all set to `"*"`.

### `/v1/control/*` dashboard session

The dashboard SPA holds no deploy-control bearer. It calls the account-plane's session-authed `/v1/control/*` routes,
and the platform worker passes those through to the embedded control plane's typed operations facade
([`core-spec.md` §31](../../core-spec.md#31-ui)). If the session gate passes but the facade is unwired, the route
returns `503`.

### `/v1/*` internal seam

`/v1/plan-runs` / `/v1/apply-runs` / `/v1/runner-profiles` / `/v1/installations/:id` (+ `/deployments` /
`/deployment-outputs`) are the **internal fetch seam** the accounts plane and CLI consume. They are not part of the §30
public vocabulary and keep the `/v1` prefix after the `/api` cutover. Because they expose internal execution profiles
(the former RunnerProfile) and the low-level plan/apply ledger, the dashboard and external integrations do not use them.

## `/api` surface (§30)

No version prefix is used; everything is mounted under `/api` ([§30](../../core-spec.md#30-api)). All routes use
operator bearer auth.

### Spaces (§4)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/spaces` | Create a Space (`@handle` owner namespace). Unrestricted bearer only. |
| GET | `/api/spaces` | List Spaces visible to the principal |
| GET | `/api/spaces/{spaceId}` | Read a Space |
| PATCH | `/api/spaces/{spaceId}` | Update a Space (MVP: `displayName` only) |

### Sources (§6)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/sources` | Register a git Source (URL-policy checked; ls-remote verification is a queued `source_sync`). Returns the hook secret once. |
| GET | `/api/sources?spaceId=` | List a Space's Sources (never includes the hook secret) |
| GET | `/api/sources/{sourceId}` | Read a Source |
| PATCH | `/api/sources/{sourceId}` | Update a Source (name / defaultRef / defaultPath / auth / status) |
| POST | `/api/sources/{sourceId}/sync` | Create a `source_sync` Run resolving the default ref to an archive snapshot |
| GET | `/api/sources/{sourceId}/snapshots` | List the Source's SourceSnapshots |

`POST /hooks/sources/{sourceId}` is the inbound forge-webhook seam, authenticated by the hook secret rather than the
bearer.

### Connections (§9)

Connection creation uses thin subroutes that fix the kind / provider / authMethod. Credential `values` are write-only
and never appear in logs or responses.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/connections/source/https-token` | Git source HTTPS-token Connection (optional username) |
| POST | `/api/connections/source/ssh-key` | Git source SSH-key Connection (`scopeHints.knownHostsEntry` required) |
| POST | `/api/connections/cloudflare/token` | Cloudflare API-token Connection (optional account/zone scope) |
| POST | `/api/connections/aws/assume-role` | **501** AWS assume-role Connection (not implemented for MVP) |
| GET | `/api/connections?spaceId=` | List a Space's Connections; with `spaceId` omitted, list operator-scope Connections (unrestricted bearer only). Never includes secret values. |
| POST | `/api/connections/{connectionId}/test` | Verify stored credentials with the provider |
| POST | `/api/connections/{connectionId}/revoke` | Revoke a Connection and delete its sealed secret blob |

`GET` / `PUT /api/operator-connection-defaults` read and write the instance-wide per-capability default Connections
(unrestricted bearer only).

### Installations + InstallConfigs (§5 / §11)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/spaces/{spaceId}/installations` | Create an Installation under a Space (`UNIQUE(space, name, environment)`, from a Source + InstallConfig) |
| GET | `/api/spaces/{spaceId}/installations` | List a Space's Installations |
| GET | `/api/installations/{installationId}` | Read an Installation |
| PATCH | `/api/installations/{installationId}` | **501** Update an Installation (not implemented for MVP; status via run lifecycle) |
| DELETE | `/api/installations/{installationId}` | **501** Delete an Installation (not implemented for MVP; use the destroy-plan flow) |
| GET | `/api/install-configs?spaceId=` | List InstallConfigs (official first-party configs, plus the Space's own configs when `spaceId` is given) |

### Dependencies (§14 / §15)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/installations/{installationId}/dependencies` | Create a Dependency edge whose consumer is this Installation (same-Space / `variable_injection`; cycles rejected) |
| GET | `/api/installations/{installationId}/dependencies` | List Dependencies (asProducer / asConsumer views) |
| DELETE | `/api/dependencies/{dependencyId}` | Delete a Dependency edge (gated by the consumer's Space permission) |

### Runs (§10 / §23)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/installations/{installationId}/plan` | Installation-driven plan Run (resolves the latest SourceSnapshot and dispatches with installation state scope) |
| POST | `/api/installations/{installationId}/destroy-plan` | destroy-plan Run (always lands `waiting_approval`, §23) |
| GET | `/api/runs/{runId}` | Unified Run projection (across the source_sync / plan / apply ledgers) |
| GET | `/api/runs/{runId}/logs` | Structured diagnostics + run-level audit trail (redacted) |
| GET | `/api/runs/{runId}/events` | Run-level audit-event trail |
| POST | `/api/runs/{runId}/approve` | Approve a waiting-approval Run (destroy / destructive change), clearing the apply gate |
| POST | `/api/runs/{runId}/cancel` | Cancel a queued or waiting-approval Run |

### Run groups (§19 / §24)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/spaces/{spaceId}/plan-update` | Create a `space_update` RunGroup (re-plan every stale Installation + downstream in topological order) |
| GET | `/api/run-groups/{runGroupId}` | Read a RunGroup with its member Runs and computed status |
| POST | `/api/run-groups/{runGroupId}/approve` | Approve every waiting-approval member Run |

### Deployments (§16)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/installations/{installationId}/deployments` | List an Installation's Deployments |
| GET | `/api/deployments/{deploymentId}` | Read a Deployment ledger record |
| POST | `/api/deployments/{deploymentId}/rollback-plan` | Create a rollback plan Run pinned to that Deployment's source snapshot (flows through normal approval/apply) |

### Output shares (§18)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/output-shares` | **501** Create a cross-Space OutputShare (not implemented for MVP) |
| GET | `/api/output-shares` | **501** List OutputShares (not implemented for MVP) |
| POST | `/api/output-shares/{shareId}/revoke` | **501** Revoke an OutputShare (not implemented for MVP) |

### Activity (§27 / §34)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/spaces/{spaceId}/activity?limit=` | List a Space's Activity audit trail (newest first; `limit` is 1..500) |

## 501 surfaces

The following surfaces exist per spec but, after passing authentication, return `501 not_implemented` (kept discoverable
without leaking an unconfigured handler).

- `POST /api/connections/aws/assume-role` — AWS assume-role Connection (post-MVP)
- `PATCH /api/installations/{installationId}` — Installation update (status flows via the run lifecycle)
- `DELETE /api/installations/{installationId}` — Installation delete (use `POST /api/installations/{id}/destroy-plan`)
- `POST` / `GET /api/output-shares`, `POST /api/output-shares/{shareId}/revoke` — cross-Space OutputShare (post-MVP)

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

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_argument` | 400 | Malformed body / param / query (incl. unknown_field) |
| `unauthenticated` | 401 | Missing / mismatched bearer |
| `permission_denied` | 403 | Out of scope (default deny) |
| `not_found` | 404 | Record absent, or surface disabled |
| `failed_precondition` | 409 | Guard / generation mismatch |
| `resource_exhausted` | 413 | Body exceeds the 1 MiB limit |
| `not_implemented` | 501 | The 501 surfaces above |
| `internal_error` | 500 | Unclassified server error |

## External install link ([§12](../../core-spec.md#12-external-install-link))

External sites pass a Git URL to deep-link into the install flow. The platform worker (accounts handler) parses and
URL-policy-checks the link, then 302s into the dashboard's Install from Git flow (no bearer; the session gate is on the
dashboard side).

```txt
GET /install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
GET /install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
```

`source=` is a Terraform/OpenTofu module address (`git::https://...//path?ref=`); the short form uses separate `git` /
`ref` / `path` queries. Git URLs must use `https://` with no embedded credentials, and literal private / loopback /
metadata IP hosts are rejected.
