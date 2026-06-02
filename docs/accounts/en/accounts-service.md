# Accounts Service Wire Details {#accounts-service-wire-details}

This page records the Cloud-compatible wire surface exposed by Takosumi Accounts. Implementation notes are limited to the final section. The canonical contract is [Cloud Distribution Contract v1](./spec.md).

## API Base URLs

- `Accounts API base URL`: Takosumi account management service.
- `Takosumi Installer API base URL`: Takosumi service.

Facade endpoints on the Accounts API base URL may share path names with Takosumi Installer API endpoints. They are still Takosumi Accounts facade routes because they add account authorization, approval, billing, and projection behavior before brokering to Takosumi.

## Endpoint Groups

| Group                       | Routes                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC standard endpoints     | `/.well-known/openid-configuration`, `/oauth/jwks`, `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, `/oauth/revoke`, `/oauth/introspect` |
| Upstream identity / passkey | `/v1/auth/upstream/*`, `/v1/auth/passkeys/*`                                                                                                    |
| Account / PAT               | `GET/POST /v1/account/tokens`, `POST /v1/account/tokens/{tokenId}/revoke`                                                                       |
| Billing usage               | `POST /v1/installations/{id}/billing/usage-reports`                                                                                             |
| Installer facade            | five `/v1/installations*` Takosumi workflow routes                                                                                                  |
| Lifecycle read/mutation     | list/get/delete/status/materialize/export/import/events                                                                                         |
| Launch token                | `POST /v1/installations/{id}/launch-token/consume`                                                                                              |
| Dashboard                   | browser-rendered views guarded by account session                                                                                               |
| Health                      | `GET /healthz`                                                                                                                                  |

See [spec route inventory](./spec.md#route-inventory) for auth and contract per route.

## Personal Access Tokens

PATs are account-scoped bearer credentials for Cloud account management APIs.

- `POST /v1/account/tokens` returns the raw `takpat_...` value once.
- Cloud stores only token hashes.
- List APIs never return bearer values.
- Scopes are `read`, `write`, and `admin`.
- Revoke takes effect immediately.
- Introspection can report active PATs for consumers that need account management authorization evidence.

## Billing Usage Reports

Usage reports require an OIDC access token issued for the same Installation. Account sessions and PATs do not cross the Installation capability boundary for usage reporting.

Required body fields:

- `reportId`
- `meter`
- positive `quantity`
- `unit`

Optional body fields:

- `periodStart`
- `periodEnd`
- `idempotencyKey`
- JSON `metadata`

The billing account is resolved from Cloud ledger state.

## Projection And Events

Cloud API read responses expose public/non-secret projection fields and refs. They do not expose raw provider responses or raw secrets.

Lifecycle events are append-only Cloud account management wire vocabulary. The base event inventory is in [the spec](./spec.md#state-and-event-model).

## Reference Implementation Notes

The reference implementation ships:

- Cloudflare Workers + D1 + R2 distribution
- Node + Postgres + Caddy distribution
- in-memory dev/test handler
- optional Stripe adapter
- optional static binding data for dev/self-host

These are implementation distributions of the Cloud profile. A compatible implementation can use different storage, job queues, dashboard framework, provider adapters, or hosting.
