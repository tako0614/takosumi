---
outline: [2, 3]
---

# Takosumi API

The Takosumi API exposes the Git-based OpenTofu control plane, provider
connections, Runs, and Interface / InterfaceBinding authorization. Takoform is
an ordinary OpenTofu provider. External hosts own any additional API or
instance lifecycle beyond this control plane.

It is not a combined clone of Cloudflare, AWS, Kubernetes, or other vendor APIs.
External infrastructure keeps its existing providers and standard APIs.

## Your first call

1. Create an API key in the dashboard ([Creating a token](./cli.md#creating-a-token)). Choose
   **Read** to only read, or both **Read** and **Write** to change things too. Untick **Restrict
   this key to the current Workspace** so the next step lists every Workspace you can use. A
   restricted key returns only its Workspace.

   The server configuration has a setting with the same name, `TAKOSUMI_DEPLOY_CONTROL_TOKEN`,
   but that one is the operator's secret and acts on every Workspace. **Never give it to users, and
   do not use it for ordinary CLI or API calls.** Use it only on the operator's machine, for
   operator-only work such as `takosumi connections`.
2. Read the Workspaces you can use. Set `TAKOSUMI_DEPLOY_CONTROL_URL` to the origin where you
   sign in to the dashboard. API paths are `/api/v1/...` on that origin.

   ```bash
   export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
   export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<your API key>

   curl -sS "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces" \
     -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
   ```

   An example response, shortened:

   ```json
   {
     "workspaces": [
       { "id": "ws_example", "handle": "alice", "displayName": "Alice", "type": "personal" }
     ],
     "returned": 1,
     "limit": 100,
     "truncated": false
   }
   ```

   Use an `id` as the `workspaceId` of other calls. One response returns at most 100; when
   there are more, it includes `nextCursor`.
3. Failures come in two shapes.
   - A missing, wrong, or expired API key returns `401` with the body `{"error":"invalid_token"}`
     and a `WWW-Authenticate` header.
   - Other failures (such as `403` for a missing permission) return JSON with `error.code`,
     `error.message`, and `error.requestId` ([Error Shape](#error-shape)). Include the
     `requestId` when you ask for help.

Some create calls require an `Idempotency-Key` header. The sections below say which ones, and
what happens when you send the same key again.

## Rule

```text
External resource has a standard API / OpenTofu provider:
  use that provider directly from a Git module (the Stack flow).

An external Host offers a Form instance:
  use that Host's own API and lifecycle contract.

One-off gap:
  use a generic connection that passes credentials as environment variables
  (--recipe generic-env --auth-mode env) with an ordinary OpenTofu module.
```

Takosumi does not ship a first-party Terraform/OpenTofu provider. Use Takoform
as an ordinary provider, and use this API, CLI, or dashboard for the supported
Git/OpenTofu control-plane operations. External providers continue to run
from ordinary Git modules (the Stack flow). Takosumi owns that Stack's Run,
state, Output, and audit records; the provider and its state still own
provider-side objects.
The Cloudflare-specific import/deploy compatibility profile is retired and is
not part of this API.

## Discovery

Every Takosumi endpoint exposes discovery.

```http
GET /.well-known/takosumi
GET /api/v1/capabilities
GET /openapi.json
```

The CLI, dashboard, and portable clients branch on capabilities, not edition names.

Example:

```json
{
  "product": "takosumi",
  "name": "Takosumi",
  "auth": {
    "oidc": true,
    "password": false
  },
  "apiBaseUrl": "https://takosumi.example.com/api/v1",
  "api_versions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "opentofu_runner": true,
    "oidc": true,
    "workload_identity": true,
    "interfaces": true
  },
  "endpoints": {
    "api": "https://takosumi.example.com/api/v1",
    "capabilities": "https://takosumi.example.com/api/v1/capabilities",
    "openapi": "https://takosumi.example.com/openapi.json",
    "oidc_issuer": "https://takosumi.example.com"
  }
}
```

Field names are case-sensitive. Most are snake_case; `apiBaseUrl` and `oidcClientId`
are camelCase. `endpoints.api` is `<origin>/api/v1`, while
`apiBaseUrl` is `<origin>/api/v1`. `features.opentofu_runner` is `true` only
when the endpoint has an OpenTofu runner configured; a composition without one,
such as the Bun + PostgreSQL reference, returns `false`.

## Authentication

API clients use a session cookie or bearer token depending on the endpoint.

```http
Authorization: Bearer <token>
```

Each Takosumi endpoint publishes the session / bearer token model enabled by
its operator through capabilities. Takosumi API keys are Takosumi
Accounts personal access tokens. Endpoints with their own standard signing
model, such as S3-compatible storage, use that protocol's signature instead.

### Accounts personal access tokens

The public Accounts PAT surface is listed below. Every response, including
authentication and input errors, carries `Cache-Control: no-store` and
`Pragma: no-cache`.

| Method | Path                                  | Authentication                     | Purpose                               |
| ------ | ------------------------------------- | ---------------------------------- | ------------------------------------- |
| GET    | `/api/v1/account/tokens`                  | account session                    | interactive list                       |
| GET    | `/api/v1/account/tokens/scopes`           | account session                    | current self-service scope catalog     |
| POST   | `/api/v1/account/tokens`                  | account session                    | create a PAT                           |
| POST   | `/api/v1/account/tokens/{tokenId}/revoke` | account session                    | revoke a PAT                           |
| GET    | `/api/v1/account/tokens/inventory.v1`     | account session                    | complete versioned metadata inventory  |
| GET    | `/api/v1/account/tokens/current`          | `Authorization: Bearer <PAT>` only | current authority of the presented PAT |

The scope catalog marks only core `read` / `write` and allowlisted extension
scopes explicitly declared by the same owning route through
`selfServicePatScopes` as self-service. Takosumi hosted AI `ai.models.read`, `ai.chat`,
and `ai.embeddings`, plus `resources:read`, require a Workspace binding.
Accounts never infers self-service authority from request scopes and never
exposes `admin` or an undeclared scope for self-service issuance.

`GET /api/v1/account/tokens/inventory.v1` does not replace the existing Dashboard
list. Its default `limit` is 50 and its hard maximum is 100. Rows are ordered
by `created_at`, then `token_id`, ascending. The response kind is
`takosumi.account-pat-inventory@v1`; its closed envelope contains only `kind`,
`tokens`, `total`, `returned`, `limit`, `truncated`, and `next_cursor`. `total`
is the complete pre-cursor count of subject-owned active and revoked PATs. One
storage statement reads that count, the exact cursor anchor, and the
`limit + 1` page. Each token contains only `token_id`, `subject`, `name`,
`prefix`, `scopes`, `workspace_id`, `created_at`, `expires_at`, `revoked_at`,
and `last_used_at`; optional metadata is `null`, and the secret is never
returned. The cursor is opaque. A malformed cursor or one whose exact
subject-owned anchor is gone returns 400 `invalid_request`.

`GET /api/v1/account/tokens/current` ignores ambient cookies,
`x-takosumi-account-session`, and query/body tokens. Accounts resolves the
presented opaque bearer across the account-session, OAuth access-token, and PAT
stores before selecting a kind. A collision, non-PAT, revoked PAT, or expired
PAT returns 401 `invalid_token`. Success kind is
`takosumi.account-pat-authority@v1`, with only `kind`, `token_id`, `subject`,
`scopes`, `workspace_id`, `expires_at`, and `workspace_role`. Generic PATs have
null Workspace fields. Workspace-bound PATs use one dedicated exact membership
SELECT: unavailable verification returns 503 `verification_unavailable`, while
an inactive or mismatched membership returns 403
`workspace_membership_inactive`. This read does not update `last_used_at`,
audit, sessions, the Control schema, or Workspace / Project / TargetPool state.

## OpenTofu Stack API

The Stack API runs ordinary OpenTofu / Terraform modules from Git. Existing
providers run as-is in this flow. The stock composition uses the provider-neutral
`opentofu-default` execution path; an operator can explicitly select a different
capability profile without using provider names as routing authority. Known
providers only receive Credential Recipe, guided setup, and cache/mirror
conveniences. Recipe presence is not an admission tier.

The module graph follows only tracked regular files and vendored local sources
(`./` and `../`) inside the immutable SourceSnapshot. V1 does not support remote
module sources, including pinned ones, and never treats them as network-fetch
authority for `tofu init`. Scan and compatibility fail closed instead of
publishing a partial provider set; vendor dependencies in the repository tree.

Operator-installed setup recipes are discovered through:

```http
GET /api/v1/credential-recipes
```

A provider without a recipe can run without a Connection or use an explicit
generic env/file ProviderConnection according to that provider's own
documentation. Non-secret `providerConfig` and `moduleInputDefaults` may carry
endpoint, region, or ordinary module defaults; credential-shaped fields are
rejected and secret values must use ProviderConnection values/files.

Every public Takosumi JSON route is under `/api/v1`. The old `/v1` namespace is
not a public API and known retired paths fail closed with 404. OIDC/OAuth,
well-known, health/metrics, and operator-only `/internal/v1` remain separate
protocol and authority surfaces.

The authoritative session-route inventory is
`accounts/service/src/control-route-inventory.ts`; it currently contains 92
public route descriptors, listed below. The descriptions follow the inventory's summaries,
lightly edited for readers.

### Account views

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/views/workspaces.v1` | Read the account Workspace inventory projection |

### Workspaces

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/workspaces` | List caller Workspaces |
| POST | `/api/v1/workspaces` | Create a Workspace |
| GET | `/api/v1/workspaces/{workspaceId}` | Read a Workspace |
| PATCH | `/api/v1/workspaces/{workspaceId}` | Update a Workspace |
| DELETE | `/api/v1/workspaces/{workspaceId}` | Delete an empty Workspace as its owner; never destroys cloud resources. Returns 409 while Capsules, Sources, in-flight Runs, usage evidence, or retained backups remain |
| GET | `/api/v1/workspaces/{workspaceId}/members` | List Workspace members |
| POST | `/api/v1/workspaces/{workspaceId}/members` | Add a Workspace member |
| PATCH | `/api/v1/workspaces/{workspaceId}/members/{subject}` | Change a Workspace member role |
| DELETE | `/api/v1/workspaces/{workspaceId}/members/{subject}` | Remove a Workspace member |
| GET | `/api/v1/workspaces/{workspaceId}/installed-apps` | Read value-free installed-app summaries for store matching |
| GET | `/api/v1/workspaces/{workspaceId}/ui-surfaces` | List authorized Workspace UI surface Interfaces |
| GET | `/api/v1/workspaces/{workspaceId}/activity` | List Workspace Activity |
| GET | `/api/v1/workspaces/{workspaceId}/interface-materialization-failures` | List Interface materialization failures, which contain no secret values |
| POST | `/api/v1/workspaces/{workspaceId}/interface-materialization-failures/{intentId}/retries` | Retry one exact Interface materialization failure |
| GET | `/api/v1/workspaces/{workspaceId}/usage` | List Workspace usage |
| GET | `/api/v1/workspaces/{workspaceId}/billing` | Read the owner's account billing state for this Workspace |
| GET | `/api/v1/workspaces/{workspaceId}/backups` | List Workspace partial control exports |
| POST | `/api/v1/workspaces/{workspaceId}/backups` | Create a Workspace partial control export |
| POST | `/api/v1/workspaces/{workspaceId}/plan-update` | Create a Workspace plan update Run |
| POST | `/api/v1/workspaces/{workspaceId}/drift-check` | Create a Workspace drift check Run |

Each member list row carries the membership fields plus `displayName` when the
account has one. `email` is returned only when the caller is an active owner or
admin of that Workspace, and never for an address the identity provider marked
unverified. Members and viewers do not receive other members' email addresses.
Add, role change, and remove responses carry neither field.

`GET /api/v1/workspaces/{workspaceId}/installed-apps` has no query parameters. With
Workspace read access, it returns `{ installedApps: [...] }`, excluding destroyed apps.
Each row has `capsuleId`, `name`, optional `displayName` (`{ja,en}`) and `iconUrl`, a light
Capsule-derived `state`, and `installedFrom: {url,path,matchable?}`. The display URL contains no
credentials, query, or fragment; `path` is the executable module's repository-relative directory.
When removing a query or other content prevents exact comparison, the row includes
`matchable: false` and is excluded from installed-app matching. Its app ID and summary are
still returned. Never-applied apps do not match. If one app's config or source cannot be read,
that row is omitted while the others remain. Matching ignores ref but preserves query as part
of executable source identity. The store uses normalized Git URL and module to show the installed
count, Open, and Install another. Installing another copy creates an independent app with separate
data and settings.

### Projects and Capsules

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/workspaces/{workspaceId}/projects` | List Workspace Projects |
| POST | `/api/v1/workspaces/{workspaceId}/projects` | Create a Project |
| GET | `/api/v1/projects/{projectId}` | Read a Project |
| GET | `/api/v1/workspaces/{workspaceId}/capsules` | List Workspace Capsules |
| GET | `/api/v1/capsules/{capsuleId}` | Read a Capsule |
| POST | `/api/v1/capsules/{capsuleId}/install-config-re-adoptions` | Re-adopt a Capsule to the latest InstallConfig in its repository, conditional on its current binding |
| PATCH | `/api/v1/capsules/{capsuleId}` | Update a Capsule |
| DELETE | `/api/v1/capsules/{capsuleId}` | Schedule deletion of an applied Capsule after a grace period; `?immediate=true` creates a destroy Plan only, which still needs review and Apply |
| POST | `/api/v1/capsules/{capsuleId}/uninstall` | Schedule a two-stage uninstall: keep resources and data through the grace period, then export and destroy |
| POST | `/api/v1/capsules/{capsuleId}/cancel-uninstall` | Cancel a scheduled uninstall during its grace period |
| GET | `/api/v1/capsules/{capsuleId}/app` | Read the server-computed installed-app view: state, primary action, problems, screens, version and uninstall terms |
| GET | `/api/v1/capsules/{capsuleId}/runs` | List the Capsule's Runs newest first with a keyset cursor |
| GET | `/api/v1/capsules/{capsuleId}/outputs` | Read the Capsule's current public Output projection |
| GET | `/api/v1/capsules/{capsuleId}/current-resource-inventory` | Read the Capsule's current recorded OpenTofu resource inventory |
| GET | `/api/v1/capsules/{capsuleId}/usage-summary` | Read the Capsule's showback usage aggregate |
| GET | `/api/v1/capsules/{capsuleId}/state-versions` | List Capsule StateVersions |
| GET | `/api/v1/capsules/{capsuleId}/provider-bindings` | Read Capsule ProviderBinding selections |
| GET | `/api/v1/workspaces/{workspaceId}/current-state-versions` | List current StateVersions for Workspace Capsules |
| GET | `/api/v1/capsule-configs` | List Capsule creation configs visible to the caller |
| GET | `/api/v1/capsule-configs/{capsuleConfigId}` | Read a Capsule creation config |
| POST | `/api/v1/capsules/{capsuleId}/plan` | Create a Capsule plan Run |
| POST | `/api/v1/capsules/{capsuleId}/configuration-plans` | Adopt a new desired configuration and provider binding in one step, and return an OpenTofu Plan for review only |
| POST | `/api/v1/capsules/{capsuleId}/destroy-plan` | Create a Capsule destroy plan Run |
| POST | `/api/v1/capsules/{capsuleId}/drift-check` | Create a Capsule drift check Run |
| POST | `/api/v1/capsules/{capsuleId}/backups` | Create a Capsule Backup |

`GET /api/v1/capsules/{capsuleId}/app` returns one view of an installed app.
The control plane computes `state` and `primaryAction` from the Capsule, this
Capsule's newest plan/apply Run, the revision and install coordinators, its
ProviderConnections and its screen materialization ledger. It does not rely on
a window of Workspace-wide Runs.

- `state`: `installing` / `installed` / `updating` / `needs_attention` /
  `stopped` / `uninstall_scheduled` / `uninstalling` / `uninstalled`
- `primaryAction`: `open` / `view_resources` / `review` / `retry` /
  `retry_screen` / `fix_connection` / `fix_interface_link` / `continue_install` /
  `cancel_uninstall` / `uninstall_now` / `reinstall` / `none`
- `problems[].code`, in priority order: `connection_unavailable` /
  `interface_link_unavailable` / `uninstall_failed` / `uninstall_blocked` / `policy_blocked` / `run_failed` /
  `capsule_error` / `install_incomplete` / `screen_unavailable` /
  `interface_link_degraded` / `interface_link_unset` / `uninstall_scheduled` (the last three are warnings)

The view also lists every launchable screen (`screens`), the adopted version and
the newest snapshot of the same ref (`version.current`, `version.latest`,
`updateAvailable`, `stale`, `autoUpdate`), in-progress work (`progress`), the
newest Run (`latestRun`) and the uninstall terms (`uninstall.mode`, the
`graceDays` that apply before anything is scheduled, and
`scheduled.deleteAfter` once scheduled). `links.uses` lists outgoing links and
`links.usedBy` lists incoming links. `uninstall.impact.usedBy` identifies consumers
affected by removal. Removing a provider leaves consumer apps in place and never
selects a replacement automatically. The view carries no secret, no Output value
and no Interface input other than a screen's checked launch URL. Parts that a
supporting read could not load are named in `incomplete`.
`progress.revisionPreparing` is true only while an install or revision
coordinator has not yet created its Plan Run (an install attempt only for a
never-applied app, and not once it has stalled). `progress.installPlanId` names
the install attempt that created the app; `continue_install` advances it with
`POST /api/v1/install-plans/{installPlanId}/reconcile`. Attempts written before
management authority was persisted can never advance and are not named. While
the attempt waits for its creator's input, `progress.installPlanAwaitingInput`
is `viewer` (the caller started it) or `other`, and reconciling does not
advance it. A revision coordinator that stopped before creating its Plan Run is
named in `progress.revisionPlanId` and continues with
`POST /api/v1/revision-plans/{revisionPlanId}/reconcile`. A revision
coordinator counts only while the state generation and InstallConfig it
started from are still the Capsule's current ones; after another change was
applied, or a settings change rebound the Capsule (which keeps the
generation), its reconcile can only fail, so it is neither preparing nor
named. Any Workspace member
may reconcile these; the Plan Run they create records the coordinator itself
(`git-install-plan:<id>` / `git-revision-plan:<id>`) as its actor, not the
member who advanced it. While a revision coordinator for the same Capsule is
still preparing its Plan (the same rule as `progress.revisionPreparing`: no Plan
Run yet, not stalled, management authority recorded, based on the current
generation and InstallConfig), another `POST /api/v1/capsules/{capsuleId}/revision-plans` is
refused with 409 (`details.reason: "revision_in_progress"`,
`details.revisionPlanId`); an exact Idempotency-Key replay is still answered.
Configuration changes (`configuration-plans`) and configuration re-adoption
(`install-config-re-adoptions`) are refused with 409
(`details.reason: "capsule_install_config_rebind_busy"`) under that same rule
only.
An uninstall record counts only while the Capsule is `uninstalled`, or while it
is `error` after a provider-reached teardown failure and its newest Run is still
a removal. A recorded `blockedReason` yields `uninstall_blocked` in either
phase. `cancel_uninstall`, `uninstall.mode` and `scheduled.cancellable` follow
the cancel and schedule commands' own admission rules.

`GET /api/v1/capsules/{capsuleId}/runs` pages newest first with `limit`
(default 50, at most 100) and `cursor`; repeat `type` to filter by Run type.

### Interface links

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/v1/capsules/{capsuleId}/interface-links/{requirementKey}/candidates` | Read matching providers and the current link generation |
| PUT | `/api/v1/capsules/{capsuleId}/interface-links/{requirementKey}` | Select a provider with generation CAS |
| DELETE | `/api/v1/capsules/{capsuleId}/interface-links/{requirementKey}` | Unlink as a consumer or provider manager |

The candidate response is `{ candidates: [{interfaceId,providerCapsuleId,providerCapsuleName,interfaceName}], generation }`.
`generation` is the latest record for this consumer and requirement key, or 0 when none
exists. PUT takes `{ interfaceId, expectedGeneration }`; DELETE takes `{ expectedGeneration }`.
Candidates are `Resolved` Interfaces owned by another Capsule in the same Workspace.
Workspace-owned and operator-owned Interfaces are not link providers.
Both return `{ link: InterfaceLink }` on success. Selecting a provider needs no Plan. It
prepares the new provider's Binding before revoking the old provider's Binding.

An InterfaceLink records the consumer Capsule and requirement key, exact type/version,
requested and approved permissions, selected provider Interface and Capsule, `state`,
`selection`, and `generation`. `state` is `pending_approval|active|declined|revoked`;
`selection` is `explicit|auto_single`. Uninstalling a provider does not rewrite the choice
or state: the app read computes its health. Only active links authorize runtime use.
Interface values and credentials do not enter OpenTofu. An absent link does not prevent
OIDC sign-in; it creates no Binding for that link.

GET requires consumer read access; PUT requires consumer write access; DELETE also permits
provider write access. Insufficient access returns 403, invalid input 400, a generation conflict 409,
and an unavailable provider 412. An approval policy port owns the decision; the current
Workspace composition approves same-Workspace links immediately.

Storage uses D1 `interface_links` (migration v76 `d1_interface_links`) and PostgreSQL
`takosumi_interface_links` (migration v122 `runtime_interfaces.links.create`). These are
additive schema changes and store no credentials. This change has not applied production
DDL or rolled out to production. Production application requires separate approval and
verification.

### Sources

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/sources` | List Sources visible to the caller |
| POST | `/api/v1/sources` | Create a Source |
| GET | `/api/v1/sources/{sourceId}` | Read a Source |
| PATCH | `/api/v1/sources/{sourceId}` | Update Source metadata |
| DELETE | `/api/v1/sources/{sourceId}` | Delete an unreferenced Source and invalidate its webhook bearer. Returns 409 while it is tracked or has a Run in flight |
| POST | `/api/v1/sources/{sourceId}/hook-secret/rotate` | Rotate the webhook bearer and return the new one once; the old bearer stops working immediately |
| POST | `/api/v1/sources/{sourceId}/sync` | Create a Source sync Run (observe by default; manual_plan for an explicit reviewed update) |
| GET | `/api/v1/sources/{sourceId}/snapshots` | List SourceSnapshots |
| GET | `/api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/install-modules` | List install module directories and provider requirements scanned from one SourceSnapshot tree |
| POST | `/api/v1/workspaces/{workspaceId}/source-ref-resolutions/stable-semver` | Resolve the highest public stable SemVer Git tag |
| POST | `/api/v1/sources/{sourceId}/compatibility-check` | Create a Compatibility Report |
| GET | `/api/v1/compatibility-reports/{reportId}` | Read a Compatibility Report |

### Git install plans

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/workspaces/{workspaceId}/install-plans` | Create or replay an idempotent Git install plan or install attempt |
| GET | `/api/v1/workspaces/{workspaceId}/install-plans` | List the caller's open install attempts for resume (`open=1`) |
| GET | `/api/v1/install-plans/{installPlanId}` | Read an install plan without advancing it |
| PATCH | `/api/v1/install-plans/{installPlanId}` | Answer an install attempt that is waiting for input (generation CAS) |
| DELETE | `/api/v1/install-plans/{installPlanId}` | Discard an install attempt and the never-applied app it created |
| POST | `/api/v1/install-plans/{installPlanId}/reconcile` | Explicitly advance an install plan toward a reviewable Run |

An install plan created with `mode: "attempt"` is owned end to end by the
coordinator. It syncs the Source, scans modules, analyzes compatibility and
matches Provider Connections itself, and pauses in the non-terminal
`awaiting_input` phase whenever it needs the user (several module candidates,
missing connections, required settings, a name collision) and once before it
creates the Capsule. `userAction` names the single next step (`wait`,
`choose_module`, `provide_inputs`, `review_run`, `retry` or `none`); a
requirement with exactly one eligible connection is selected automatically.
Only the member who started the attempt may `PATCH` or `DELETE` it. `PATCH`
uses `expectedGeneration` as a CAS fence, and only the confirming
`continue: true` request carries variable values, which go straight into the
atomic initial creation and are never stored. Once a confirming request has
started creation (with or without variables) a Capsule may exist, so when the
outcome cannot be confirmed only the same values may be sent again and an
already committed Capsule is adopted first. `DELETE` first makes sure no lease
holder is working on the attempt, then abandons the never-applied Capsule it
created and records the terminal `discarded` phase; if the abandonment stops,
the attempt is left `failed` (`install_attempt_discard_incomplete`) and another
`DELETE` finishes it. It is refused once the app is applying or applied, and
for plans that are not attempts. The Source is never deleted; only polling
that the attempt itself turned on is turned off.

For `userAction.kind: "provide_inputs"`, `interfaces` lists each `requirementKey`, exact
type/version, permissions, value-free candidates, `choice`, and `autoSelected`. No candidates
allows later; one is selected automatically; several require a provider or later. PATCH
`interfaceLinks` replaces the complete answer list with entries shaped as
`{requirementKey,choice:{kind:"interface",interfaceId}}` or
`{requirementKey,choice:{kind:"later"}}`. The selected provider ID lives in this answer,
not the manifest. Immediately after Capsule creation, it becomes a pinned InterfaceLink
and is never resolved again from the candidate set.

To confirm displayed automatic choices, send
`observedInterfaces: [{requirementKey,interfaceId}]` together with `continue: true`.
An explicit `interfaceLinks` answer takes precedence for that requirement; otherwise,
if the displayed ID is no longer the sole eligible candidate, the response is
409 `interface_candidate_unavailable`. GET the fresh sheet and confirm it again.
These observations contain IDs only, are never stored in `options`, and grant no authority.

Attempts carry `expiresAt` only until their Capsule exists; an attempt with a
Capsule never expires. GET and the open listing never write: an expired
attempt (`install_attempt_expired`) or one whose management epoch changed
while it waited (`workspace_management_changed`) is reported through
`invalidated` and `userAction: retry`, and cleaned up only by its creator's
`DELETE` or by a creator `PATCH` that finds it invalid (409
`install_attempt_invalid`). `awaiting_input` holds no lease and no execution
authority, so it does not block Workspace management, and neither does an
unleased attempt that expired before its Capsule existed, since it can no
longer advance; every write that advances an attempt re-checks the original
admission in the same statement.

Idempotency: the request digest covers variable names but never their values,
so reusing an Idempotency-Key with different values replays the first record
(200) instead of returning a conflict. Use a new key for new values.

### Git revision plans

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/capsules/{capsuleId}/revision-plans` | Create or replay an idempotent Git revision plan |
| GET | `/api/v1/revision-plans/{revisionPlanId}` | Read a Git revision plan without advancing it |
| POST | `/api/v1/revision-plans/{revisionPlanId}/reconcile` | Advance a Git revision plan toward a reviewable Run |

### Runs and StateVersions

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/workspaces/{workspaceId}/runs` | List Workspace Runs |
| GET | `/api/v1/runs/{runId}` | Read a Run |
| POST | `/api/v1/runs/{runId}/approve` | Approve a Run |
| POST | `/api/v1/runs/{runId}/apply` | Apply a reviewed Run |
| POST | `/api/v1/runs/{runId}/cancel` | Cancel a Run |
| GET | `/api/v1/runs/{runId}/logs` | Read Run logs |
| GET | `/api/v1/runs/{runId}/events` | Read Run events |
| GET | `/api/v1/runs/{runId}/cost` | Read Run cost projection |
| GET | `/api/v1/run-groups/{runGroupId}` | Read a grouped Run |
| POST | `/api/v1/run-groups/{runGroupId}/approve` | Approve a grouped Run |
| GET | `/api/v1/state-versions/{stateVersionId}` | Read a StateVersion projection |
| POST | `/api/v1/state-versions/{stateVersionId}/rollback-plan` | Create a StateVersion rollback plan |

A plan Run that policy blocked or that requires approval carries
`policyReasons`: `{ code, layer, provider?, resourceType? }` items whose `code`
and `layer` come from a closed set (for example `provider_not_allowed` /
`provider`, `approval_required_change` / `action`). The prose reasons are not
returned; a reason this build does not recognize stays as `unclassified`.

A plan Run created by a version change (automatic updates included), a
rollback to an earlier StateVersion, a configuration change or a Workspace
update carries `origin` (`{ kind: "revision", ref }`,
`{ kind: "rollback", stateVersionId }`, `{ kind: "configuration" }` or
`{ kind: "update" }`), so a client retrying a failed change plans the same
change again instead of the Source's default ref.

### Credentials

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/connections` | List Connections |
| POST | `/api/v1/connections` | Create a write-only credential Connection |
| POST | `/api/v1/connections/{connectionId}/test` | Verify a Connection |
| POST | `/api/v1/connections/{connectionId}/revoke` | Revoke a Connection |
| POST | `/api/v1/connections/oauth/{helperId}/start` | Start an installed credential OAuth helper |
| GET | `/api/v1/connections/oauth/{helperId}/callback` | Complete an installed credential OAuth helper |
| GET | `/api/v1/provider-connections` | List ProviderConnections visible to a Workspace |
| GET | `/api/v1/credential-recipes` | List optional guided Credential Recipes |

### Dashboard projections

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/dashboard/bootstrap` | Read the dashboard session bootstrap projection |
| GET | `/api/v1/dashboard/overview` | Read the dashboard Workspace overview projection |

Webhook secret recovery, old-secret invalidation, and lost-response handling are described in
[Sources and Capsules](../concepts/sources.md). The equivalent service-internal route is
`POST /internal/v1/sources/{sourceId}/hook-secret/rotate`.

Capsule deletion requires Workspace owner/admin authority and a write scope
(`write` or `admin` for an API key, `capsules:write` for OAuth). By default, `DELETE /api/v1/capsules/{capsuleId}` schedules
deletion of an applied Capsule and returns `202 {capsule,graceDays}`. The operator
setting `TAKOSUMI_UNINSTALL_GRACE_DAYS` controls the grace period (7 days by
default in OSS); while it is pending, cancel it with
`POST /api/v1/capsules/{capsuleId}/cancel-uninstall`. Retrying after destruction
returns `200 {capsule,alreadyDeleted:true}`. A Capsule that has never been applied
keeps the existing immediate abandonment behavior.

To create the legacy immediate destroy Plan, explicitly call
`DELETE /api/v1/capsules/{capsuleId}?immediate=true`. It returns `202 {run}` and
creates a Plan only. Destruction still requires an owner to review and approve the
Plan, then apply that Run. `immediate=false` has the same meaning as the default;
other values return `400`. `POST .../uninstall` and `POST .../destroy-plan` remain
available.

This changes the DELETE response contract. At release cutover, the old implicit
immediate-Plan meaning of DELETE ends; there is no implicit legacy fallback. The
existing POST uninstall and destroy-plan routes are the migration bridge. Clients
that need deletion without a grace period can add `immediate=true` before cutover.
Compatibility operation lasts only while the old artifact is in service.

`POST /api/v1/capsules/{capsuleId}/uninstall` moves an applied Capsule to
`uninstalled` and destroys nothing before `uninstall.scheduledDestroyAt`. The
grace period is the operator setting `TAKOSUMI_UNINSTALL_GRACE_DAYS` (OSS
default 7 days). During the grace period the provider resources and their data
remain, billing continues, sign-in through a Takosumi OIDC client pauses (the
client is kept, so a cancel resumes it), and every plan or apply other than teardown is
refused with `capsule_uninstalled`. `cancel-uninstall` returns the Capsule to
its previous status. Once due, the control plane attempts one Capsule-scoped
export, records the outcome (`exported`, `failed`, or `skipped`) in
`uninstall.preDestroyExport`, and then creates an ordinary destroy plan. Only a
plan whose known changes are all deletions is approved by the system and
applied; from then on the uninstall normally cannot be cancelled. A plan that
is not delete-only or not verifiable, a plan the owner cancelled, or a teardown
refused or failed before reaching the provider stops with
`uninstall.blockedReason` for the owner to cancel or delete immediately. A
teardown that fails after reaching the provider ends in `error`, like any
failed destroy.
`destroy-plan` creates an immediate destroy plan.

Create a Capsule through the Git install-plan coordinator. It pins the exact
SourceSnapshot and successful compatibility declaration, creates the complete
initial authority atomically, and returns a Plan Run for review. The public
Workspace Capsule collection is GET-only.

Creating a Git install plan requires `Idempotency-Key`. Replaying the same
normalized request in the same Workspace and actor scope returns the same
record; reusing the key for different input returns 409. Its public projection
contains only bounded references to the Source, immutable SourceSnapshot,
DB-owned InstallConfig, Capsule, and canonical Plan Run. Private variable values
supplied at creation remain only in non-public coordinator state until the
atomic initial-authority commit, are never projected, and are removed from the
coordinator immediately after that commit. Credentials, tokens, and Output
values are rejected. Reconciliation stops at a reviewable Plan Run;
approval and apply remain exclusively on the Run API, with no install-plan apply
route.

`POST /api/v1/capsules/{capsuleId}/configuration-plans` accepts the closed
body `{variablePatch:{set,remove},providerBindings,interfaceBlueprints,expected:{authorityGuard}}`.
It patches only the private current InstallConfig, resolves value-free provider
bindings, and seals an immutable successor while preserving the existing
source, module, policy, runner, lifecycle, output, Interface, runtime, and
provenance authority. The InstallConfig pointer, ProviderBindingSet, pending
Interface intents, and execution-authority epoch are changed under one CAS;
the endpoint then creates a review-only OpenTofu Plan and never starts Apply.
For a repository-manifest Capsule, only exact manifest user-input declarations
authorize the patch. For a generic OpenTofu Capsule, the route rechecks the
stored variable-contract digest against the successful compatibility
declaration for the exact SourceSnapshot and uses only those declared
names/basic types/default markers; it never infers a latest Snapshot or
manifest.

The first completed request returns 201. If the insert-only successor or exact
authority CAS committed but its acknowledgement was lost before the canonical
Plan became durable, retry completes the remaining work and still returns
`201` with `replayed:false`. Once the canonical Plan is durable, an ordinary
identical same-key replay (including a lost Plan acknowledgement) returns `200`
with `replayed:true`, the same target, and the same durable `planRunId`; it does
not create another Plan row. Reusing the key for different input conflicts with
409. The route rejects reserved redaction sentinels, invalid variable
patches/removals, stale authority guards, destroyed/disabled Capsules, and
in-flight revision work.

Public `PATCH /api/v1/capsule-configs/{id}` and
`PUT /api/v1/capsules/{id}/provider-bindings` are retired for every row,
including unmarked legacy rows. After authenticating and authorizing the
Workspace, both return `405 Method Not Allowed` with `Allow: GET`. Configuration
Plan or the dedicated re-adoption operation is the only deployment-intent
mutation authority for an existing Capsule.

The create body selects provider connections by the exact module-local tuple
from the scan, not by a provider-source-only map:

```json
{
  "source": {
    "name": "sample-app",
    "url": "https://git.example.test/apps/sample-app.git",
    "ref": "main",
    "path": "infra"
  },
  "capsule": { "name": "sample-app", "environment": "production" },
  "options": {
    "modulePath": "deploy/selected",
    "providerBindings": [
      {
        "provider": "registry.terraform.io/tako0614/takoform",
        "moduleLocalName": "takoform",
        "connectionId": "conn_takoform"
      }
    ]
  },
  "preflight": {
    "sourceId": "src_exact",
    "sourceSnapshotId": "snap_exact",
    "compatibilityCheckRunId": "run_compatibility_exact",
    "compatibilityReportId": "report_exact",
    "installConfigId": "cfg_exact"
  }
}
```

`source.path` is the Git subtree to sync; `options.modulePath` is an
archive-relative module discovered by that snapshot's tree scan. Each
`providerBindings` `provider` / `moduleLocalName` / optional `childAlias` must
exactly match a requirement tuple for the selected module. `connectionId` is
only a reference to an existing Connection.
`preflight` pins the successful, ready compatibility declaration for that exact
SourceSnapshot and module. Dashboard and smoke installs use this create-only
coordinator; they do not create a Capsule and fill in bindings through a later
public PUT.

Creating a Git revision plan also requires `Idempotency-Key` and accepts only
`{ "ref": "<git-ref>" }`. Creation returns 201, replaying the same normalized
request under the same key returns 200, and reusing the key for different input
returns 409. It fences the existing Capsule, Source,
InstallConfig, and state generation; it does not patch the Source default ref or
path. Reconciliation creates deterministic SourceSyncRun, SourceSnapshot,
compatibility, and Plan Run evidence so a lost acknowledgement adopts the same
canonical mutation. An unconfirmed mutation returns 202 with
`nextAction: "reconcile"`; a reviewable Run returns `nextAction: "review_run"`
and stops. State rollback remains the
separate `POST /api/v1/state-versions/{stateVersionId}/rollback-plan` flow.

Creating or reconciling a revision plan does not change what the Capsule
tracks. Only a successful apply that advances `currentStateVersionId` adopts
the Plan Run's SourceSnapshot as the Capsule's tracking authority.
`GET /api/v1/capsules/{capsuleId}` exposes that non-secret derived value as
`adoptedSourceRevision: { sourceSnapshotId, ref, path, resolvedCommit }`; it is
absent before the first successful apply.

Interactive clients such as the Dashboard read Workspaces through bounded
pages. `limit` is capped at 100, `cursor` is the opaque token returned by the
previous page, and `order` is either `created_asc` or `updated_desc`. Passing
the current Workspace as `selectedWorkspaceId` pins that authorized Workspace
to the first response even when it falls outside the ordinary page;
`pinnedWorkspaceId` identifies the extra row. The ordinary page still contains
at most `limit` rows and the full response at most `limit + 1`.

```http
GET /api/v1/workspaces?limit=50&order=updated_desc&selectedWorkspaceId=ws_current
GET /api/v1/workspaces?limit=50&order=updated_desc&cursor=<opaque>
```

The response contains `workspaces`, `returned`, `limit`, `truncated`, and
optional `nextCursor` / `pinnedWorkspaceId`. Only management operations that
need an exact count request `includeTotal=true`; ordinary interactive reads
omit it so D1/Postgres complete with a `limit + 1` probe and no extra
`count(*)`. The queryless `GET /api/v1/workspaces` is also a bounded page in
`created_asc` order with a maximum of 100 rows. Clients that genuinely need all
authorized Workspaces must follow `nextCursor`.

Account-wide migration and discovery clients use the separate read-only
projection:

```http
GET /api/v1/views/workspaces.v1?limit=100&cursor=<opaque>
```

This route derives its subject only from the authenticated account session and
always requests active membership rows in `created_asc` order with archived
Workspaces included and an exact `total` counted before cursor filtering. The
default and hard maximum `limit` are 100; the only accepted query keys are
`limit` and `cursor`. A Workspace-scoped session, PAT, or OAuth credential is
rejected with 403, and the route performs no personal-Workspace bootstrap or
other writes. The response `kind` is
`takosumi.account-workspace-inventory@v1` and contains `workspaces`, `total`,
`returned`, `limit`, `truncated`, and an optional opaque `nextCursor`.

The Dashboard reads launcher Interfaces authorized with `ui.open` for the
exact Principal derived from the current account session through one
account-session API request. Optional `capsuleId` is only an owner filter and
does not influence the authorization principal. The response contains only
authorized Interfaces and never exposes InterfaceBinding records.

```http
GET /api/v1/workspaces/{workspaceId}/ui-surfaces?limit=100
GET /api/v1/workspaces/{workspaceId}/ui-surfaces?capsuleId={capsuleId}&limit=50
GET /api/v1/workspaces/{workspaceId}/ui-surfaces?cursor=<opaque>&limit=100
```

The response contains `interfaces` and an optional `nextCursor`. The read
defaults to 100 rows and clamps larger limits to 100. Authorization is resolved
with a bounded current-Principal Binding query; listing never reconciles or
writes Interface lifecycle state. Individual invocation and token issuance
still revalidate the exact Interface and Binding immediately before use.

A Run is one operation ledger entry. Its `type` is one of `source_sync`,
`compatibility_check`, `plan`, `apply`, `destroy_plan`, `destroy_apply`,
`drift_check`, `backup`, or `restore`. Plan and Apply are separate Runs, and the
Apply Run is linked to the reviewed Plan Run by `planRunId`.

A Capsule that builds from a Git checkout can declare an optional `sourceBuild`
at creation time. This is not Store metadata; it is a Capsule setting that the
user explicitly approves.

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

Each command is an argv array, not a shell string. `workingDirectory` and
`outputs` are limited to relative paths inside the Git checkout, and no
provider credential is passed to the build phase. When `sourceBuild` is not
set, the OpenTofu module resolves its artifact as usual from a release
artifact URL/digest, a provider, or a data source.

Public hostnames, DNS, and application endpoints belong to the ordinary
OpenTofu module and provider in the Git checkout. Takosumi neither synthesizes
nor reserves Capsule hostnames; `public_endpoint` metadata only projects an
applied Output into the UI.

A Run stores:

```text
source snapshot
OpenTofu version
provider lock digest
ProviderBinding
injected env metadata, not values
plan/apply result
state version
outputs
logs
actor
audit evidence
```

`Source.defaultRef` accepts a branch, tag, or commit. When `Source.autoSync` is
enabled, the scheduler or source webhook syncs both the Source default address
and each ref/path lane adopted by a current Capsule StateVersion. The resolved
commit is stored as a `SourceSnapshot`. An active Capsule becomes `stale`
when the new snapshot is on its adopted ref/path lane and differs from its
currently applied snapshot. Another lane never stales it or rewrites the Source
default. Ordinary update plans also select the latest snapshot on the adopted
lane. From there, the existing Workspace update /
RunGroup flow creates a reviewable plan, and apply follows the normal Run
approval path. Takosumi does not choose or fetch application artifacts outside
the OpenTofu module.

An explicit update review first syncs the Source, then pins the immutable
`SourceSnapshot` produced by that request into compatibility checking and the
plan. A client must not accept an older pre-existing snapshot as the result of a
new sync request. The session API supports an explicit intent:

```http
POST /api/v1/sources/{sourceId}/sync
Content-Type: application/json

{ "intent": "manual_plan" }
```

`observe` (the default) is for webhook and scheduled observation and may
evaluate Capsule auto-update when the Capsule opted in. `manual_plan` prepares
a user-reviewed plan and does not independently start another auto-update
plan/apply. Continue only after the returned SourceSyncRun is `succeeded` and
its `sourceSnapshotId` is present in the Source snapshot list.

## OIDC / Workload Identity

See [shared account and Workspace](./shared-account.md) for the explicitly
enabled first-party profile. Shared identity does not replace current Workspace
membership or the billing owner's authorization.

Takosumi Accounts exposes the standard issuer surface for registered OIDC
clients.

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
GET  /oauth/authorize
POST /oauth/token
```

A standalone ServiceAccount/workload-federation API is not part of the current
public surface. Core does not expose fixed AWS, GCP, or Kubernetes federation
routes or credential kinds. A future workload-identity surface must use generic
OIDC principals, Resource Credential/Policy, or explicit Credential Recipe
pre-run actions and ship only with matching implementation and discovery.
Operator/hosted service may add Enterprise SSO, SCIM, and commercial audit export through
that generic seam.

Takosumi does not infer or register an Accounts OIDC client from Git metadata,
provider output, product identity, hostname convention, or an arbitrary provider
call. Provider runtime-binding remains read-only and has no registration
authority; the Takosumi-owned generic Accounts capability implementation owns
final Apply activation. A reviewed repository manifest may request the generic `identity.oidc`
capability only with exactly one paired `http.endpoint`. Read-only Plan requires
the exact Plan-known canonical HTTPS endpoint and pins exactly four non-secret
delivery values: `accountsUrl`, `issuerUrl`, `clientId`, and `redirectUri`.
Takosumi may register the Capsule-bound client idempotently only during final
Apply revalidation; no ProviderBinding, private descriptor, owner-subject
variable, provider fallback, or client secret belongs to this lane.
Already-registered Capsule clients revalidate the current Capsule,
InstallConfig, accepted repository provenance, Workspace membership, and scopes
on every use; invalid terminal bindings are revoked best-effort. Accounts tokens
and Interface invocations continue to validate both scope and Workspace.
Consumers must encrypt token material in their secret store and never place it
in OpenTofu state or Outputs.

The optional `workspace_id` selector on `GET /oauth/authorize` lets a Principal
with multiple Workspaces choose the token's authority scope. Accounts
revalidates live membership immediately before issuing the authorization code
and, for a Capsule-owned client, also verifies the Capsule's owning Workspace.
Duplicate, empty, control-character, oversized, or unauthorized values are
rejected. The resulting access token records only the verified Workspace and
role.

A static composition OIDC client may likewise request a Workspace-bound token by
supplying `workspace_id`. For this Capsule-free client, the ID token and UserInfo
responses emit `takosumi.workspace_id` and the current `takosumi.role`, and omit
`capsule_id`. UserInfo emits exactly one `workspace_memberships` entry:
`[workspace_id]`. Capsule-owned clients continue to include their verified
`capsule_id` in `takosumi`. If membership is revoked or suspended, UserInfo and
refresh are rejected fail-closed.

## Error Shape

Failures return structured errors.

```json
{
  "error": {
    "code": "capability_not_available",
    "message": "compat.example.v1 is not enabled for this endpoint",
    "requestId": "req_123"
  }
}
```

Secret values, temporary credentials, and internal adapter credentials are never
included in errors.

The exception is a failed bearer check. A missing, wrong, or expired API key returns `401`
with the body `{"error":"invalid_token"}` and a `WWW-Authenticate: Bearer error="invalid_token"`
header. OIDC and OAuth endpoints return the standard `{ error, error_description }`.

## Versioning

The current API version is `takosumi.dev/v1alpha1`.

```text
v1alpha1:
  breaking changes are allowed. Update docs and conformance together.

v1beta1:
  core shape is fixed. Upgrade and conversion guidance required.

v1:
  backward compatibility maintained. No field removals.
```

OSS / Operator / hosted-service differences are represented by capabilities, not API
version.
