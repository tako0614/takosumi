# Legacy Workspace usage telemetry

TASK-0118 Phase 9 removes Workspace in stages. Stage 9.3 (Workspace routes
return 410) may start only after production shows **seven consecutive days
with no legacy Workspace use** outside an explicit allow list, and stage 9.4
(Workspace claims stop) needs the same evidence for Workspace claims. This
runbook explains what stage 9.0 records and how to read it. Recording is
always on; there is no switch. Reading it changes nothing.

## What is recorded

Every legacy use writes one structured, value-free log line (`console.info`
JSON). Lines never contain an account, subject, Workspace, Capsule, request or
token id, a concrete path, a query value or a raw `User-Agent`.

### `legacy_workspace_route`

| Field | Values |
| --- | --- |
| `surface` | `workspace_route` (`/api/v1/workspaces/*`, `/projects/*`, `/views/workspaces.v1`), `workspace_query` (`?workspaceId=` on connections, sources, capsule-configs, provider-connections, dashboard), `workspace_body` (`workspaceId` in a connection-create, connection-OAuth-start or source-create body), `workspace_projection` (dashboard bootstrap without `includeWorkspaces=false`), `shared_workspace` (`/api/v1/account/shared-workspaces*`), `interface_workspace` (`/api/v1/interfaces*?workspaceId=`), `platform_extension_workspace` (an extension route given `?workspaceId=`), `authorize_workspace` (`/oauth/authorize?workspace_id=`), `pat_workspace` (a PAT created with `workspace_id`) |
| `route` | Route template from the control route inventory, e.g. `/api/v1/workspaces/{workspaceId}/runs`, `/api/v1/connections?workspaceId`, `/api/v1/sources#workspaceId`. Unknown leaves become `*` |
| `method`, `status` | HTTP method and the final status (refusals are counted too) |
| `entry` | `public` (Accounts `/api/v1` and OIDC), `operator_mcp`, `shared_auth`, `platform` (Interface API, extension routes) |
| `credential` | `session`, `personal-access-token`, `oauth-access-token`, `none`, or `unknown` (the composition had not resolved it) |
| `workspaceBound`, `appBound` | Whether the credential was bound to a Workspace or to apps |
| `clientFamily` | `Takosumi-Client` name from a fixed list (`takosumi-dashboard`, `takosumi-cli`, `takos`, `takosumi-mobile`, ...), else `client:unknown`, else a coarse User-Agent family (`ua:browser`, `ua:browser-mobile`, `ua:bun`, `ua:node`, `ua:curl`, `ua:python`, `ua:go`, `ua:okhttp`, `ua:apple-native`, `ua:none`, `ua:other`) |
| `clientId` | Only for an OAuth access token: the registered OAuth client id (an app integration, not a person) |

The dashboard sends `Takosumi-Client: takosumi-dashboard` and the CLI sends
`Takosumi-Client: takosumi-cli`. The header is deliberately not `x-takosumi-*`:
browser billing refuses that prefix and the shared-auth and extension
boundaries strip it.

### `legacy_workspace_claim_emitted`

Written whenever an ID token, userinfo or introspection response carries a
compatibility `takosumi.workspace_id` claim.

| Field | Values |
| --- | --- |
| `surface` | `id_token`, `userinfo`, `introspection`, `interface_oauth_userinfo`, `interface_oauth_introspection` |
| `clientId` | The registered OAuth client that received the claim |
| `capsuleBound` | `capsule_id` was in the same claim set (the app can already use the app claims) |
| `appRole` | `app_role` was in the same claim set |
| `memberships` | The flat `workspace_memberships` claim was emitted too |

Stage 9.4 looks for clients with `capsuleBound: false`: those still depend on
the Workspace claim.

### Response headers

Each legacy route response also carries:

- `Deprecation: @1793145600` (RFC 9745; 2026-10-28, the decision date);
- `Link: <https://takosumi.com/docs/reference/api#legacy-workspace-routes>; rel="deprecation"`,
  plus `rel="successor-version"` when a replacement route exists today;
- `Sunset: <HTTP-date>` (RFC 8594) only when `TAKOSUMI_LEGACY_WORKSPACE_SUNSET`
  is set. Set it to the approved stage 9.3 date (ISO date or HTTP-date); an
  invalid value fails Accounts startup, and the platform composition ignores
  it for its own responses.

### Counter

The Cloudflare platform Worker also records the counter
`takosumi_legacy_workspace_route_count` (tags `route`, `method`, `status`,
plus the usual `environment` and `runner_profile_id`) through the same
best-effort metric path as `takosumi_oidc_request_count`. A use visible only
in a request body is tagged `route=body`. Logs remain the source for the gate;
the counter is a quick trend view on `/metrics`.

## Reading it in Workers Logs

The platform Worker has `[observability] enabled = true` with full head
sampling, so every line reaches Workers Logs. Retention depends on the
account plan; read the gate inside the retention window.

1. Cloudflare dashboard → Workers & Pages → the platform Worker (`takosumi`
   in production) → Observability / Logs.
2. Filter on the structured field `event` equal to `legacy_workspace_route`
   (or `legacy_workspace_claim_emitted`). If fields are not extracted for the
   line, filter the message text for the event name instead.
3. Set the time range to the last 7 days and group by `route`, `credential`
   and `clientFamily` (add `clientId` for OAuth). Exclude the allow list:
   `surface` in `shared_workspace` and `platform_extension_workspace`
   (stage 9B), and operator scripts by their `clientFamily`.
4. The stage 9.3 gate is met when that grouped count is 0 for 7 consecutive
   days, in production and in staging.

The same filter works through the Workers Observability telemetry query API.
For a live look, `wrangler tail <worker> --format json` piped to a filter on
`legacy_workspace_route` shows lines as they happen.

Self-hosted (Node/Postgres) deployments write the same lines to stdout; the
platform counter is Cloudflare-only.

Browser billing (`/api/v1/billing*`, Workspace-selected on every request) is
deliberately not marked: it is a stage 9B allow-listed surface with a closed
response and console contract. Count it from the invocation log request URL
(path starting with `/api/v1/billing`) until stage 9B moves it to the account.

## Related signals

- `app_authorization_workspace_fallback` (existing): an app request decided by
  the rollout Workspace fallback. Stage 9.5 requires 7 days at 0.
- Apps add `legacy_workspace_claim_used` in their own Workers during stage 9.2.
