# Accounts Service Wire Details {#accounts-service-wire-details}

このページは Takosumi Accounts が公開する Cloud-compatible wire surface を記録します。実装ノートは最後の section に分離します。正本 contract は [Cloud Distribution Contract v1](./spec.md) です。

## API Base URLs

- `Accounts API base URL`: Takosumi アカウント管理 service。
- `Takosumi Installer API base URL`: Takosumi service。

Accounts API base URL 上の facade endpoint は Installer API endpoint と同じ path を持てます。ただし、それらは account authorization、approval、billing、投影 behavior を足して Takosumi に broker する Takosumi Accounts facade route です。

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
| Dashboard                   | account session で guard された browser-rendered view                                                                                           |
| Health                      | `GET /healthz`                                                                                                                                  |

route ごとの auth と contract は [spec route inventory](./spec.md#route-inventory) を参照してください。

list / inspect は account session bearer (`sess_...`) を使い、 mutation 例は owner subject の account session bearer または `write` / `admin` PAT (`takpat_...`) を明示的に渡します。

## Personal Access Tokens

PAT は Cloud アカウント管理 API 用の account-scoped bearer credential です。

- `POST /v1/account/tokens` は raw `takpat_...` を発行時に 1 度だけ返す。
- Cloud は token hash だけを保存する。
- list API は bearer value を返さない。
- scope は `read`、`write`、`admin`。
- revoke は即時反映。
- introspection は active PAT をアカウント管理の authorization evidence として report できる。

## Billing Usage Reports

usage report は同じ Installation に対して発行された OIDC access token を要求します。account session と PAT は usage reporting の Installation capability boundary を越えません。

required body fields:

- `reportId`
- `meter`
- positive `quantity`
- `unit`

optional body fields:

- `periodStart`
- `periodEnd`
- `idempotencyKey`
- JSON `metadata`

billing account は Cloud ledger state から解決します。

## Managed Offering Access Gate

Managed Takos の public exposure は default closed です。`accounts serve` で開く場合は、先に
`takosumi launch-readiness validate --json` で readiness bundle を検証し、出力された canonical
`evidenceDigest` を `--managed-offering-readiness-digest <validate-json evidenceDigest>` として渡します。別途
`--managed-offering-approval-ref <ref>` で operator approval を渡し、public summary と private evidence ref も同じ
bundle に紐づけます。

閉じたままにする public surface は `/start`、`/dashboard/use-takos`、core OAuth authorize/token、personal access token
create、`/v1/installations/dry-run`、`/v1/installations`、`/v1/installations/import`、dashboard install dry-run/apply、
deployment/materialize/export access mutations、install/deployment 内の OIDC client / permission scope materialization、
status ready/reopen patch、ready or installing、dashboard deployment operations、launch-token creation/consume、upstream OAuth authorize/callback、
`/v1/billing/stripe/checkout`、passkey register / authenticate route です。

## Projection And Events

Cloud API read response は public/non-secret な投影 field と ref だけを返します。raw provider response や raw secret は返しません。

lifecycle event は append-only Cloud アカウント管理の wire vocabulary です。base event inventory は [spec](./spec.md#state-and-event-model) にあります。

## Reference Implementation Notes

reference implementation は次を ship します。

- Cloudflare Workers + D1 + R2 distribution
- Node + Postgres + Caddy distribution
- in-memory dev/test handler
- optional Stripe adapter
- optional static binding materials for dev/self-host

これらは Cloud profile の reference implementation です。compatible な実装は別の storage、job queue、dashboard framework、provider adapter、hosting を使えます。
