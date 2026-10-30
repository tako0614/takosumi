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
`accounts/service/src/control-route-inventory.ts`; it currently contains 107
public route descriptors, listed below. Accounts compositions include the same routes in `/openapi.json` and publish their count as `x-takos-public-session-endpoint-count`. Core-only processes omit the unmounted Accounts routes. The descriptions follow the inventory's summaries,
lightly edited for readers.

### App ownership and personal resources

`GET /api/v1/apps?cursor&limit` lists the caller's owned and shared apps, with a live `role`, owner display name, app state and primary action. Using an app does not grant management access.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/capsules/{capsuleId}/members` | Owner/member; only owner sees email |
| POST | `/api/v1/capsules/{capsuleId}/members` | Owner; `{ email, consent: "connections_and_code" }`; verified account |
| DELETE | `/api/v1/capsules/{capsuleId}/members/{accountId}` | Owner or the departing member; cancels their queued/pending approval runs atomically |
| GET | `/api/v1/capsules/{capsuleId}/ownership-transfers?state=pending` | Owner or recipient; `{ ownershipTransfers: [...] }` with app and sender display names |
| GET | `/api/v1/ownership-transfers?state=pending` | Up to 50 pending transfers addressed to caller, with app and sender display names |
| POST | `/api/v1/capsules/{capsuleId}/ownership-transfers` | Owner; `{ toAccountId }`; at most 50 pending per recipient and 10 creations per sender per hour |
| POST | `/api/v1/ownership-transfers/{transferId}/accept` | Recipient; drains runs, increments ownership epoch, resets provider bindings |
| DELETE | `/api/v1/ownership-transfers/{transferId}` | Owner; cancels pending transfer |
| GET, POST | `/api/v1/connections` | Account's own personal connections and bindable operator connections; new connections belong to caller |
| GET | `/api/v1/connections?capsuleId=…&projection=labels` | The owner's or a member's own session or personal access token (including appIds-scoped ones); the connections this app can bind (the owner's verified connections, operator-provided bindable connections and the current bindings) as `{ id, provider, displayName }` only, so a member can switch among them; no values, status, scope or other details. An installed app's OAuth token gets only the connections already bound to that app. Each request reads at most one fixed-size page of the owner's connections (`owner_account_id` has no index yet) and continues with `nextCursor`; a page can hold fewer than `limit` rows because unbindable connections are skipped. Binding and credential mint (connection owner must be the app owner) remain the authority |
| POST | `/api/v1/connections/oauth/{helperId}/start` | Account credential; omit workspaceId to create a personal connection owned by caller |
| GET | `/api/v1/source-ref-resolutions?url=…` | Account credential with write scope; starts a runner to resolve a public Git source's stable SemVer tag |
| POST | `/api/v1/install-plans` | Account credential; `mode: "attempt"`, no workspace field; caller owns app |
| GET | `/api/v1/usage` | Account credential; caller's payer usage only. An independent meter event is attributed only when its usage span (event time ±2 hours, never before the app's creation or after it was recorded) lies inside one ownership interval delimited by accepted transfers; otherwise, or with incomplete transfer history, it stays unattributed |

While the operator sets `TAKOSUMI_APP_OWNERSHIP_MUTATIONS=frozen`, member add/remove/leave and transfer offer/accept/cancel return `409 failed_precondition` with `details.reason: "app_ownership_mutations_frozen"` before any app is read. Member addition returns `202 { accepted: true }` for both unknown emails and verified accounts. The owner consent `connections_and_code` is retained in the audit ledger. Accepting a transfer removes all existing members and records notification recipients in the audit ledger. Member management, transfers, acceptance, cancellation and uninstall require the person's own session or a PAT with explicit scopes; installed-app OAuth access tokens are refused.

PATs may set `appIds`; effective permission is token scopes intersected with the caller's current app role. App-bound credentials cannot read account-wide personal resources. Workspace routes and claims remain compatibility surfaces. Installed-app OIDC accepts any account and always identifies the app with `takosumi.capsule_id`; only current managers receive `takosumi.app_role`. Nonmembers receive no management role.

### App management permissions

Once an app has an ownership row (`capsules.owner_account_id`), the caller's role in that app is the only management authority. A Workspace owner or admin who is not the app's owner or member cannot manage it, and an app owner or member does not need Workspace membership. People who only use an app are not members; the app's own URL and access rules decide that.

| Action (`AppAction`) | Owner | Member | Main routes |
| --- | --- | --- | --- |
| `view` | yes | yes | `GET /capsules/{id}` and its GET sub-routes; GET of that app's Runs, StateVersions, Sources, InstallConfigs and compatibility reports |
| `change_settings` | yes | yes | `PATCH /capsules/{id}`, `configuration-plans`, `install-config-re-adoptions`, `backups`, owned Source `PATCH` and hook secret |
| `update` | yes | yes | `plan`, `revision-plans`, `drift-check`, owned Source `sync` and `compatibility-check`, approve/apply/cancel of ordinary Runs |
| `rollback` | yes | yes | `POST /state-versions/{id}/rollback-plan`, approval of restore Runs |
| `choose_connection` | yes | yes | `configuration-plans` with `providerBindings`; only the owner's connections and bindable operator connections can be chosen |
| `change_interface_link` | yes | yes | `PUT`/`DELETE /capsules/{id}/interface-links/{key}`; as the provider app, listing `interface-links/requests` and `approve`/`decline` |
| `uninstall` | yes | no | `DELETE /capsules/{id}`, `uninstall`, `cancel-uninstall`, `abandon`, `destroy-plan`, approve/apply/cancel of destroy Runs, owned Source `DELETE` |
| `transfer_ownership` | yes | no | `ownership-transfers` |
| `manage_members` | yes | no | adding or removing `members` (a member may leave) |

Refusals are `403 app_access_denied` (no app role) or `403 app_owner_only` (owner-only action). If ownership changes between the ownership read and the role read, the request fails with `409 conflict` and should be retried. After an uninstall completes, the retained owner and members can still read the app's history.

A Source belongs to its owner app (`ownerCapsuleId`). An existing Source without an owner belongs to every live app built from it, and every one of those apps must allow the action under its own rule: the per-app decision for an app with an ownership row, the legacy Workspace decision for an app without one. Neither rule stands in for the other. Its `source_sync` Runs and compatibility reports follow the same rule. A Run whose Source was removed has no app and uses the Workspace decision.

An Interface link is approved at creation only when the requester also has `change_interface_link` on the provider app (the Workspace decision for a provider without an ownership row); otherwise it is created `pending_approval`. Links created during install (an explicit choice, or the automatic choice of a sole candidate) follow the same rule, and the person continuing the install must also be the install plan's creator, who is recorded as the approver.

A `pending_approval` link becomes active when the provider app's owner or a member (the Workspace decision for a provider without an ownership row) approves it with `POST /capsules/{providerId}/interface-links/{linkId}/approve`, and `declined` when they `decline` it. The decision is `change_interface_link` on the provider app; being the consumer app's owner or member grants nothing here. Both check that the link is still pending and current, that `expectedGeneration` matches, that both the provider and the consumer app are live (`active` or `stale`) and not scheduled for uninstall, and re-check the caller's role (including an ownership-transfer epoch change) immediately before the write. An approval grants exactly the requested permissions. Partial approval is not supported yet: when `approvedPermissions` is sent it must be the requested set (any order), otherwise `400 invalid_request` (a partial approval would leave the consumer with a lasting reapproval warning and no way to ask again short of revoking). After approval, people using the consumer app get their Bindings on their next sign-in, exactly as for a link approved at creation. Either side can revoke with `DELETE`. After a decline or an approval, the consumer can choose a provider again.

Re-pointing an existing link to a provider that would leave it `pending_approval` is refused with `409 interface_link_approval_required`, and the current link (active or pending) is kept, so the app does not lose its Interface while waiting. To ask for approval, `DELETE` the current link and choose again: the new link is created `pending_approval` and the provider app's owner or a member can approve it. A `PUT` naming the same provider returns a `pending_approval` link unchanged and does not activate it.

Credential restrictions apply before any role: an app outside a PAT's `appIds`, or an app in another Workspace than a Workspace-bound PAT or OAuth token, is refused. An installed app's own OAuth access token (issued to the app's per-install OIDC client and bound to that app) works only for that app. Another app's routes, Runs, Sources and install plans of another app, and Workspace-level routes (lists, creating `install-plans`, and so on) return `403`. Even on its own app it passes only when both the app role and the legacy Workspace decision allow the request; it cannot uninstall (including `destroy-plan`, `DELETE /capsules/{id}` and approving or applying destroy Runs), transfer ownership, manage members or choose new connections, and it never approves another app's Interface (except as described for designated apps below). It cannot list, approve or decline pending links (`interface-links/requests`, `approve`, `decline`), not even for its own app: `403 app_access_denied`. The only exception is an app currently applied from a repository and an allowed ref the operator lists in `TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES` (an app such as Takos that installs apps for its user). The decision is server-side: the token's bound app must be live in the token's Workspace (not disabled or scheduled for uninstall), its Source (whose URL cannot be changed) and the applied revision's path must match the list, and the full ref name the runner recorded on that revision's snapshot (`resolvedRef`) must match an allowed `refs/heads/…` or `refs/tags/…` entry. The ref name requested at install (`main`, `HEAD`, and so on) is not used, because `git ls-remote` matches name suffixes and a name such as `1/head` can resolve to `refs/pull/1/head`. For an install without a ref, the runner records `HEAD` as the default branch (`refs/heads/…`). Snapshots without `resolvedRef` (fetched by commit SHA, or before it was recorded) and refs outside `refs/heads/` and `refs/tags/` (such as `refs/pull/*`) never qualify, and no client claim is used. Only the owner can change what a designated app deploys (revision plans, `rollback-plan`, the Source's `defaultRef`/`defaultPath`, InstallConfig re-adoption); for an app without an ownership row, only the Workspace owner. A designated app's token may uninstall another app its user owns (for an app without an ownership row: when its user is the Workspace owner), but never uninstalls its own app, transfers ownership or manages members, and it approves an Interface link at creation only when its user has `change_interface_link` on the provider app. It approves or declines a pending link only when its user is the provider app's owner or a member, and never for a link to its own app. A non-designated app's token may create plans for its own app but cannot approve, apply or cancel Runs (that needs a session or PAT): Runs record only the person who created them (the same person as the token's user), not the client, so cancel is refused for such tokens entirely; it also cannot change the Source's connection (`authConnectionId`), create a Workspace InstallConfig through `compatibility-check`, or name another app's InstallConfig. A designated app's token works within its bound Workspace, still limited to what both the app role and the Workspace decision allow. Operator-registered static clients (tokens not bound to an app) are unchanged. Shared-account compositions that require current membership (`requireCurrentMembership`) also need both the app role and the Workspace decision.

Workspace-level routes (lists, Workspace settings, Workspace creation, unowned preflight Sources, Workspace connections) keep the legacy Workspace decision as compatibility surfaces until Phase 9. Lists (`/workspaces/{id}/capsules`, `runs`, `activity`, `current-state-versions`, `backups`, `usage`, `installed-apps`, `interface-materialization-failures`, `/dashboard/overview`, `/sources?workspaceId=`) omit rows of apps with an ownership row that the caller cannot view, and actions on such apps go through the per-app decision. The app's owner and active members can view it (after an uninstall completes, the owner and members on the retained ownership row still can); an owned app outside a PAT's `appIds` is not shown. `/workspaces/{id}/usage` likewise omits the usage and cost of apps the caller cannot view; a payer's own usage is `GET /api/v1/usage`.

The cursor-paged lists (`capsules`, `current-state-versions`, `runs`, `backups`, `usage`, `/dashboard/overview`, `/sources?workspaceId=`) select only visible rows in the store query (memory, Postgres, D1). However many hidden rows come first, pages fill with visible rows and paging reaches the end. `nextCursor` is the store's cursor for a visible row; ids and timestamps of hidden rows never appear in it. A row belongs to these apps: a Run to its Capsule (an older apply row without one: its plan's Capsule), else to its Source's apps; a Source to its owner app, or, while ownerless, to every live app built from it; a backup to its Capsule, or, when it names none, to every live app; a usage event to its Capsule, else to its Run's apps. A usage event whose Run is gone is hidden while the Workspace has an app with an ownership row. A row is hidden when any app it belongs to is hidden. A target without the ownership schema (before D1 v77 / Postgres v123) does not filter. A host that wires an ownership store but does not provide these filtered reads answers these lists with `503` instead of an unfiltered list.

Activity is attributed to apps by its Capsule target, Capsule ids in metadata (every `memberCapsuleIds` entry of a run group), an Interface's owner app (`ownerId`), a binding's Capsule subject (`subjectId`) and the provider app of the Interface a binding or token names, its Source (the apps built from it, or its owner app), and, when nothing else names an app, its Run (`runId`, a Run target, `metadata.runId`/`planRunId`/`applyRunId`). A backup that names no app is Workspace-wide and belongs to every live app. While the Workspace has apps with an ownership row, events whose app cannot be determined (a missing Run or Interface, a Capsule id this Workspace does not have, a lookup past the cap, no attribution) are omitted even when another reference resolves; `workspace` and `connection` events and events known to belong to no app (a Run or Source no app uses, a removed Source) keep the Workspace decision. `/dashboard/bootstrap?includeNotifications=true` uses the same rule. Reads: the Workspace's Capsule list and one batch ownership read first; with no owned app (every app on v75) nothing more is read. Otherwise Run, Source and Interface reads are deduplicated, run in parallel and capped at 50 per request. Workspace bulk actions (`plan-update`, `drift-check`, Workspace backup, Interface materialization retries) require the Workspace decision and, in addition, that the action is allowed on every app in the Workspace that has an ownership row.

**During the rollout.** An app whose ownership row is not usable yet is decided by the legacy Workspace rule for that request: when the composition has no ownership store, when the schema predates D1 v77 / Postgres v123, or when the backfill has not written the app's owner yet. From the moment an ownership row exists, that app is decided per app only. Each fallback is reported as the id-free structured log `app_authorization_workspace_fallback` (`reason` is `ownership_store_unavailable`, `ownership_schema_unavailable` or `capsule_not_backfilled`), aggregated per isolate at most once every five minutes. Each decision reads the ownership row once, and the role resolution reads it again when a row exists. The ownership store's existing schema check is reused; on a pre-v77 D1 its "no schema" result is trusted for 60 seconds, so decisions do not probe on every request.

### Account views

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/views/workspaces.v1` | Read the account Workspace inventory projection |

### Legacy Workspace routes {#legacy-workspace-routes}

Workspace is being replaced by per-app ownership and removed in stages (TASK-0118 Phase 9). These uses are deprecated:

- `/api/v1/workspaces/*`, `/api/v1/projects/*`, `/api/v1/views/workspaces.v1`
- connections, sources, capsule-configs, provider-connections and dashboard selected by `?workspaceId=`, and connection create, connection OAuth start and Source create selected by a `workspaceId` body field
- `/api/v1/dashboard/bootstrap` without `includeWorkspaces=false`
- `/api/v1/account/shared-workspaces*`, `/api/v1/billing*` (responses are not marked), `/api/v1/interfaces*` when a Workspace is selected (by `?workspaceId=`, the `x-takosumi-platform-workspace-id` header, a `workspaceId` body field, or implicitly by a Workspace-bound credential), platform extension routes that receive a Workspace, `workspace_id` on `/oauth/authorize`, and personal access tokens created with `workspace_id`

Their responses carry `Deprecation: @1793145600` (RFC 9745) and `Link: <…>; rel="deprecation"` pointing here, plus a `rel="successor-version"` link when a replacement route exists today and is a concrete URI (templated replacements such as `/api/v1/capsules/{capsuleId}/runs` are listed in the table below, never sent as a link), and `Sunset` (RFC 8594) once the operator schedules removal (`TAKOSUMI_LEGACY_WORKSPACE_SUNSET`). Status and body are unchanged. Clients may identify themselves with `Takosumi-Client: <name>/<version>`. The server records each authenticated use as the structured log `legacy_workspace_route`, and each compatibility `takosumi.workspace_id` claim placed in an ID token, userinfo or introspection response (including the introspection of a Workspace-bound personal access token) as `legacy_workspace_claim_emitted`. Neither contains an account, Workspace or token id; the only identifier is the registered OAuth client id, which identifies an app integration or installation, not a person.

| Deprecated | Replacement |
| --- | --- |
| `GET /api/v1/workspaces`, `GET /api/v1/workspaces/{workspaceId}/capsules`, `GET /api/v1/workspaces/{workspaceId}/installed-apps`, `GET /api/v1/views/workspaces.v1` | `GET /api/v1/apps` |
| `POST /api/v1/workspaces/{workspaceId}/install-plans` | `POST /api/v1/install-plans` |
| `GET /api/v1/workspaces/{workspaceId}/members` | `GET /api/v1/capsules/{capsuleId}/members` |
| `GET /api/v1/workspaces/{workspaceId}/runs` | `GET /api/v1/capsules/{capsuleId}/runs` |
| `GET /api/v1/workspaces/{workspaceId}/usage`, `GET /api/v1/workspaces/{workspaceId}/billing` | `GET /api/v1/usage` |
| `POST /api/v1/workspaces/{workspaceId}/source-ref-resolutions/stable-semver` | `GET /api/v1/source-ref-resolutions` |
| `POST /api/v1/workspaces/{workspaceId}/plan-update` / `drift-check` / `backups` | `POST /api/v1/capsules/{capsuleId}/plan` / `drift-check` / `backups` |
| `/api/v1/connections` selected by `workspaceId` | `/api/v1/connections` without `workspaceId` (personal connections) |

Replacements for the remaining routes are added as their APIs land.

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
Workspace read access, it returns `{ installedApps: [...], complete: boolean }`, excluding destroyed apps.
Each row has `capsuleId`, `name`, optional `displayName` (`{ja,en}`) and `iconUrl`, a light
Capsule-derived `state`, and `installedFrom: {url,path,matchable?}`. The display URL contains no
credentials, query, or fragment; `path` is the executable module's repository-relative directory.
When removing a query or other content prevents exact comparison, the row includes
`matchable: false` and is excluded from installed-app matching. Its app ID and summary are
still returned. Never-applied apps do not match. If one app's config or source cannot be read,
that row is omitted while the others remain. `complete: false` means that discovery could not
finish, for example after a bulk config read failure or the bounded Source page limit.
Returned matches remain useful; an unmatched listing cannot be assumed uninstalled.
Matching ignores ref but preserves query as part
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
  `cancel_uninstall` / `uninstall_now` / `reinstall` / `none` (`review_interface_link` is a problem card's own action and never the `primaryAction`)
- `problems[].code`, in priority order: `connection_unavailable` /
  `interface_link_unavailable` / `uninstall_failed` / `uninstall_blocked` / `policy_blocked` / `run_failed` /
  `capsule_error` / `install_incomplete` / `screen_unavailable` /
  `interface_link_degraded` / `interface_link_unset` / `interface_link_approval_pending` / `uninstall_scheduled` (`interface_link_degraded`, `interface_link_unset` and `uninstall_scheduled` are warnings; `interface_link_approval_pending` is `info` on the provider app for a link request the caller may approve, points at `review_interface_link`, and never decides the `primaryAction`)

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
| GET | `/api/v1/capsules/{capsuleId}/interface-links/requests` | Read links waiting for this (provider) app's approval |
| POST | `/api/v1/capsules/{capsuleId}/interface-links/{linkId}/approve` | Approve a pending link as the provider's owner or member (generation CAS) |
| POST | `/api/v1/capsules/{capsuleId}/interface-links/{linkId}/decline` | Decline a pending link as the provider's owner or member (generation CAS) |

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

The pending list `GET .../interface-links/requests` requires `change_interface_link` on the provider app and returns
`{ requests: [{ linkId, generation, consumerApp: { capsuleId, name, displayName?, iconUrl? }, requirementKey,
providerInterfaceId, interfaceType, interfaceVersion, requestedPermissions, requestedByDisplayName?, createdAt }] }`,
which is value-free (names, permission names and timestamps only). `requestedByDisplayName` is the requester's display name only, never an email address or account id (it is omitted when the account has none, or when it equals or looks like an email address or account id). `approve` takes `{ expectedGeneration, approvedPermissions? }`
and `decline` takes `{ expectedGeneration }`; both require provider write access and return `{ link: InterfaceLink }`.
An approved link carries `approval.kind: "provider_approved"`; a declined link carries `declined: { declinedBy, declinedAt }`.
A link that is no longer pending or a generation mismatch is 409; a provider or consumer that is not live (including scheduled for uninstall or removed) is 412.
Activity records `interface_link.approved` / `interface_link.declined` with ids, permission names and type/version only.

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
| DELETE | `/api/v1/sources/{sourceId}` | Retire an unreferenced Source and its owned archives, then invalidate its webhook bearer. Returns 409 while tracked, in flight, or awaiting safe cleanup |
| POST | `/api/v1/sources/{sourceId}/hook-secret/rotate` | Rotate the webhook bearer and return the new one once; the old bearer stops working immediately |
| POST | `/api/v1/sources/{sourceId}/sync` | Create a Source sync Run (observe by default; manual_plan for an explicit reviewed update) |
| GET | `/api/v1/sources/{sourceId}/snapshots` | List SourceSnapshots |
| GET | `/api/v1/sources/{sourceId}/snapshots/{sourceSnapshotId}/install-modules` | List install module directories and provider requirements scanned from one SourceSnapshot tree |

Source deletion uses archive custody when the Source is owned, retiring, or has snapshot/sync history.
It deletes archives first, then atomically removes snapshots and the Source with `source.retired`
Activity. Failed cleanup keeps the rows for retry. Only pristine unowned Sources use `source.deleted`.
| POST | `/api/v1/workspaces/{workspaceId}/source-ref-resolutions/stable-semver` | Resolve the highest public stable SemVer Git tag |
| POST | `/api/v1/sources/{sourceId}/compatibility-check` | Create a Compatibility Report |
| GET | `/api/v1/compatibility-reports/{reportId}` | Read a Compatibility Report |

Source deletion uses archive custody when the Source is owned, retiring, or has snapshot/sync history.
It deletes archives first, then atomically removes snapshots and the Source with `source.retired`
Activity. Failed cleanup keeps the rows for retry. Only pristine unowned Sources use `source.deleted`.

### Git install plans

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/workspaces/{workspaceId}/install-plans` | Create or replay an idempotent Git install plan or install attempt |
| GET | `/api/v1/workspaces/{workspaceId}/install-plans` | List the caller's unfinished installs (`open=1`) |
| GET | `/api/v1/install-plans/{installPlanId}` | Read an install plan without advancing it |
| PATCH | `/api/v1/install-plans/{installPlanId}` | Answer an install attempt that is waiting for input (generation CAS) |
| DELETE | `/api/v1/install-plans/{installPlanId}` | Discard an install attempt, or an install plan before it recorded its app |
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
for a plan that is not an attempt once it recorded its app (409
`install_plan_not_attempt`). Its dedicated Source is retired, polling and sync admission stop,
and archives and snapshot rows are removed. The same DELETE or the daily sweep resumes
an interrupted retirement.

An install plan created without `mode` (not an attempt) also checks, right
before it creates the Capsule, that no live app uses its name in the same
Workspace and environment. If one does, the plan ends `failed` with
`capsule_name_conflict` instead of retrying. When the initial Capsule creation
is refused with `failed_precondition` (`capsule_initial_authority_conflict`),
for example because an app with the same name committed after that check, the
plan does not retry either: if this plan's own deterministic Capsule already
exists (its commit acknowledgement was lost), it is adopted and the plan moves
on; a name collision ends it with `capsule_name_conflict`; anything else ends
it `failed` with code and reason `capsule_initial_authority_conflict`. An
attempt still returns to its input sheet. A plan that is not an attempt can be
discarded by the member who started it, with `DELETE` and its
`expectedGeneration`, while it has not recorded its Capsule (`syncing_source`
through `creating_capsule`, or `failed` there). The discard first makes sure no
lease holder works on it, abandons a never-applied Capsule left by a lost
acknowledgement exactly as for an attempt, and records `discarded`
(`install_plan_discarded`). Such plans are also listed by `open=1`. They never
expire, and a drain settles only plans that were never claimed, so this
`DELETE` is how a stopped plan stops blocking Workspace management.

Once an attempt has created its Capsule and reached `planning` or `reviewable`,
GET and the open-attempt list include `reviewSummary`. It reconstructs the
module path, app name, environment, committed Provider Binding connection IDs
and display labels, Interface choices, and setting names and set markers from
the stored InstallConfig and BindingSet. A setting `value` appears only for a
non-sensitive input in an accepted repository install UX. Generic OpenTofu
variables and sensitive settings expose only `sensitive: true` and `set`, never
their values. Historical automatic Provider Connection selection cannot be
recovered from a committed binding, so its `autoSelected` is `null`. These
reads do not advance Plan or Apply.

For `userAction.kind: "provide_inputs"`, `interfaces` lists each `requirementKey`, exact
type/version, permissions, value-free candidates, `choice`, and `autoSelected`. No candidates
allows later. One is selected automatically only if it is not private and is not also a
candidate for another requirement. Private providers, duplicates, and several candidates
require an explicit provider or later choice. PATCH
`interfaceLinks` replaces the complete answer list with entries shaped as
`{requirementKey,choice:{kind:"interface",interfaceId}}` or
`{requirementKey,choice:{kind:"later"}}`. The selected provider ID lives in this answer,
not the manifest. Immediately after Capsule creation, it becomes a pinned InterfaceLink
and is never resolved again from the candidate set.

To confirm displayed choices, send
`observedInterfaces: [{requirementKey,candidateIds}]` together with `continue: true`.
An explicit `interfaceLinks` answer takes precedence for that requirement. The server
compares the echoed candidate IDs with the current candidate set, so a set that changed
after the sheet opened is accepted when it still matches at submission time.
Different sets return 409 `interface_candidate_unavailable`. An omitted observation uses
the captured sheet-open candidate set instead.
The response's `installPlan.implicitInterfaceKeys` identifies implicit answers stored in
`options.interfaceLinks`, including a sole-candidate auto-selection or “configure later”,
so a restarted attempt can distinguish them from explicit choices. These observations contain
IDs only, are never stored in `options`, and grant no authority.
When Control D1 has not installed the Interface link store (schema before v76),
the install sheet offers no candidates, returns `linkStoreUnavailable: true` with
guidance, and saves no selection. Choosing “configure later” proceeds without
attempting to create a link. An explicit choice of a pre-v76 candidate is refused
before Capsule creation.

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
