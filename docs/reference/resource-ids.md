# Resource IDs

> このページでわかること: resource ID の命名規則と生成ルール。

Takosumi v1 の resource ID grammar、 v1 ID kind の閉じた一覧、 各 kind の suffix
grammar、 kernel 境界での canonical / display 形式、 そして再生成可否 を決める
stability rule を定義します。

resource ID は kernel が persist する **唯一の** identity surface です。
他の識別子 (operator 内部の数値 primary key、 runtime-agent ローカル handle、
connector handle) は kernel 再起動を跨いで安定ではありません。 本ページの
surface が kernel API response、 audit event、 snapshot、 journal entry、 CLI
output に露出します。

## ID grammar

Takosumi v1 の resource ID は次の閉じた形をとります。

```text
<kind>:<unique-suffix>
```

ルール:

- `kind` は下記の閉じたリストにある kebab-case ASCII 識別子
- `:` は kind と suffix を区切る唯一の delimiter。 v1 のどの kind でも suffix に
  literal `:` を含めない
- `unique-suffix` は kind 固有の grammar (ULID / UUID v4 / sha256 hex /
  content-addressed hash / kebab-case の operator 名)
- ID 全体は case-sensitive。 ULID suffix は Crockford base32 (慣例で大文字)、
  sha256 suffix は小文字 hex
- ID 内部に空白を含まない。 前後の空白も ingest で reject

`<kind>:` は予約 prefix。 plugin 作者 / operator は新 kind を発明できず、
追加には `CONVENTIONS.md` §6 RFC が必須です。

## v1 closed kind list

v1 で kind list は閉じています。 下記 base table は kernel domain の kind
(manifest / journal / snapshot / share / group) を列挙し、 PaaS provider
primitive の追加分は
[v1 closed kind additions for PaaS provider primitives](#v1-closed-kind-additions-for-paas-provider-primitives)
に続きます。 kernel が API 境界で受理する kind はこれらの table のいずれかに
必ず現れ、 それ以外は reject されます。

| Kind              | Suffix grammar                               | suffix の由来                                                  |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `space`           | kebab-case 名                                | operator が指定                                                |
| `deployment`      | ULID                                         | apply 時に kernel が生成                                       |
| `link`            | `<consumer>.<slot>`                          | consumer object ID と slot 名から導出                          |
| `object`          | kebab-case 名                                | Space 内で operator が指定                                     |
| `generated`       | `<owner-kind>:<owner-id>/<reason>`           | kernel 生成、 owner から決定的                                 |
| `exposure`        | kebab-case 名                                | Space 内で operator が指定                                     |
| `journal`         | ULID                                         | WAL entry ごとに kernel が生成                                 |
| `operation`       | ULID                                         | OperationPlan entry ごとに kernel が生成                       |
| `desired`         | sha256 hex                                   | DesiredSnapshot canonical encoding に対する content-address    |
| `resolution`      | sha256 hex                                   | ResolutionSnapshot canonical encoding に対する content-address |
| `activation`      | ULID                                         | activate 時に kernel が生成                                    |
| `revoke-debt`     | ULID                                         | entry enqueue 時に kernel が生成                               |
| `approval`        | ULID                                         | approval 発行時に kernel が生成                                |
| `connector`       | kebab-case id                                | operator が install                                            |
| `export-snapshot` | sha256 hex                                   | export 内容に対する content-address                            |
| `catalog-release` | sha256 hex または operator tag の kebab-case | 既定は content-address。 operator が tag を pin できる         |
| `policy`          | sha256 hex                                   | policy bundle に対する content-address                         |
| `group`           | kebab-case 名                                | Space 内で operator が指定                                     |

これが v1 の閉じた集合です。 新 kind の追加 / 削除、 既存 kind の suffix grammar
変更には `CONVENTIONS.md` §6 RFC が必須。

### Examples

```text
space:acme-prod
deployment:01HM9N7XK4QY8RT2P5JZF6V3W9
link:object:web-app.database
object:web-app
generated:link:object:web-app.database/projection
exposure:public-api
journal:01HM9N7XK4QY8RT2P5JZF6V3W9
operation:01HM9N7XK4QY8RT2P5JZF6V3W9
desired:sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
resolution:sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
activation:01HM9N7XK4QY8RT2P5JZF6V3W9
revoke-debt:01HM9N7XK4QY8RT2P5JZF6V3W9
approval:01HM9N7XK4QY8RT2P5JZF6V3W9
share:01HM9N7XK4QY8RT2P5JZF6V3W9
connector:cloudflare-workers-bundle
external-participant:partner-org
export-snapshot:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
catalog-release:sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0
policy:sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
group:rollout-canary
```

## v1 closed kind additions for PaaS provider primitives

下記 kind は PaaS provider primitive (identity、 tenant lifecycle、 quota / SLA
enforcement、 incident response、 support impersonation、 notification) が
導入する resource を v1 closed kind list に追加するものです。 上節の closure
rule が同様に適用され、 各追加 kind は固定の suffix grammar と suffix 由来に
紐付き、 これを超える kind 追加には `CONVENTIONS.md` §6 RFC が必須です。

### Account plane の追加 kind

`actor` / `organization` / `membership` / `role-assignment` / account `api-key`
/ `auth-provider` の識別子は、 operator の account plane (reference 実装:
`takosumi-cloud/` の Takosumi Accounts) が所有し、 takosumi kernel resource ID
には属しません。 詳細は account plane 側の docs を参照。 cross-product audit
evidence には opaque な文字列としてのみ現れます。

`actor:` には support-staff Actor のための sub-kind 識別子があり、 通常の Actor
は `actor:<name>` / `actor:<uuid>` 形式を用います。 suffix に `:` は
含められませんが、 Actor ID に限り `/` が sub-kind の区切りとして 1 つだけ
許可されます。

### PaaS operations の追加 kind

| Kind                   | Suffix grammar | suffix の由来                                            | 参照                                                            |
| ---------------------- | -------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `tier`                 | kebab-case 名  | quota tier 登録時に operator が指定                      | [Quota Tiers](/reference/quota-tiers)                           |
| `incident`             | ULID           | incident open 時に kernel が生成                         | [Incident Model](/reference/incident-model)                     |
| `support-grant`        | ULID           | operator が grant 作成時に kernel が生成                 | [Support Impersonation](/reference/support-impersonation)       |
| `support-session`      | ULID           | `approved` grant 下で session を開くときに kernel が生成 | [Support Impersonation](/reference/support-impersonation)       |
| `notification-signal`  | ULID           | notification signal emit 時に kernel が生成              | [Notification Emission](/reference/notification-emission)       |
| `provisioning-session` | ULID           | tenant provisioning session 開始時に kernel が生成       | [Tenant Provisioning](/reference/tenant-provisioning)           |
| `export-job`           | ULID           | Space export request 時に kernel が生成                  | [Tenant Export and Deletion](/reference/tenant-export-deletion) |
| `sla-threshold`        | ULID           | operator が SLA threshold 登録時に kernel が生成         | [SLA Breach Detection](/reference/sla-breach-detection)         |
| `sla-observation`      | ULID           | SLA observation emit 時に kernel が生成                  | [SLA Breach Detection](/reference/sla-breach-detection)         |

この追加 table にも closure rule が適用されます。 1 kind は 1 suffix grammar
に固定で、 ここで非 ULID は `tier:` のみ。 追加には `CONVENTIONS.md` §6 RFC
が必須。 v1 grammar (`<kind>:<unique-suffix>`、 kebab-case `kind`、 suffix 内に
`:` 禁止) は緩めません。 `actor:support-staff/<id>` sub-kind は唯一の 例外で、
`actor:` kind 限定です。

### Examples

```text
actor:alice
actor:b3a1f6e8-3d6f-4b2a-9c1d-2c7a8e0f5a31
actor:support-staff/jane
organization:acme
membership:01HM9N7XK4QY8RT2P5JZF6V3W9
role-assignment:01HM9N7XK4QY8RT2P5JZF6V3WA
api-key:01HM9N7XK4QY8RT2P5JZF6V3WB
auth-provider:acme-oidc
tier:pro
incident:01HM9N7XK4QY8RT2P5JZF6V3WC
support-grant:01HM9N7XK4QY8RT2P5JZF6V3WD
support-session:01HM9N7XK4QY8RT2P5JZF6V3WE
notification-signal:01HM9N7XK4QY8RT2P5JZF6V3WF
provisioning-session:01HM9N7XK4QY8RT2P5JZF6V3WG
export-job:01HM9N7XK4QY8RT2P5JZF6V3WH
sla-threshold:01HM9N7XK4QY8RT2P5JZF6V3WJ
sla-observation:01HM9N7XK4QY8RT2P5JZF6V3WK
```

### Stability 区分

追加 kind は下節の stability rule に対応します。

- **operator-controlled name (immutable、 rename 不可)**: `tier:` および
  provider / runtime 識別子。 account plane の識別子は Takosumi Accounts 所有
- **kernel-minted ULID (発行後 immutable)**: `incident:` / `support-grant:` /
  `support-session:` / `notification-signal:` / `provisioning-session:` /
  `export-job:` / `sla-threshold:` / `sla-observation:`

追加 table に content-addressed kind は導入しません。 SHA suffix は元節で列挙
した kind に予約されています。

### Workflow 形の ID

kernel は `trigger:` / `trigger-registration:` / `hook-binding:` / `workflow:` /
`workflow-run:` / `workflow-step-run:` prefix を予約していません。 workflow /
cron / hook は `POST /v1/deployments` の上位 (例: `takosumi-git`) で扱い、
識別子は kernel が管理する kind list の外で保持します。 詳細は
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
を参照。

## Suffix grammar

v1 で各 suffix grammar は閉じています。

### ULID

26 文字 Crockford base32、 time-sortable。 ミリ秒解像度の timestamp prefix + 80
bit 乱数で生成。 timestamp 解像度内で生成順と辞書順が一致。 ULID は発行 後
immutable で、 kernel は同じ論理 resource に再発行しません。

### UUID v4

future extension のため予約。 v1 で UUID v4 を使う kind は現状なし。 canonical
hyphen 区切り小文字形式で文書化。

### sha256 hex

SHA-256 digest の小文字 hex (常に 64 文字)。 ID には先頭 `sha256:` token を
付け、 将来 `CONVENTIONS.md` §6 RFC で別 hash に置換できる余地を残します。
content-addressed kind の canonical encoding は
[Digest Computation](/reference/digest-computation) を参照。

### kebab-case 名

ASCII 小文字 + 数字 + `-`。 先頭は letter、 末尾は `-` 不可、 連続 `-` 不可。
最大 63 文字。 operator-controlled kind (`space` / `object` / `exposure` /
`connector` / `external-participant` / `group`、 operator-tag の
`catalog-release`) で使用。

### Composite suffix

2 つの kind は他 ID から導出した composite suffix を使います。

- `link:<consumer>.<slot>` — `<consumer>` は consumer object の完全 ID (kind
  prefix 付き)、 `<slot>` は consumer の shape spec が宣言する slot 名
- `generated:<owner-kind>:<owner-id>/<reason>` — `<owner-kind>` / `<owner-id>`
  は所有 resource、 `<reason>` は kernel が生成時に選ぶ閉じた短い token (例:
  `projection`、 `materialization`)

composite suffix の構築は決定的で、 同じ owner / reason は常に同じ generated ID
を生みます。 同一 projection rule の replay で新規 ID を生成しません。

## Display form

ID は等価な 2 形式で露出します。

- **canonical**: 単一文字列 `<kind>:<suffix>`。 storage、 JSON 埋め込み、 audit
  log で使う形式
- **tuple form**: ID の Space context が重要な場面で
  `(space:<name>, <kind>:<suffix>)`。 Space を跨ぐ集計の CLI 出力で使う

CLI の人間向け表示には **path form** を使います。

```text
space:acme-prod/deployment:01HM9N7XK4QY8RT2P5JZF6V3W9
```

path form は Space ID と resource ID を `/` で結合します。 path form は
informational で、 kernel 境界での source of truth は canonical 形式です。

## Cross-Space 参照 (将来)

Space A の resource が Space B の resource を参照する場面では tuple form を
使います (例: `(space:b-prod, object:shared-config)`)。 将来 cross-Space surface
(snapshot field、 audit event、 approval binding) では tuple form が
必須になります。 bare `<kind>:<suffix>` は暗黙に Space-local で、 active Space
context を指します。

## ID stability rule

ID の安定性は kind に依存します。

### Content-addressed (永続的に immutable)

`desired:sha256:...` / `resolution:sha256:...` / `export-snapshot:sha256:...` /
`policy:sha256:...`、 content-addressed `catalog-release:sha256:...`。 内容の
hash なので、 内容変更で新 ID を生成し、 既存 ID を再利用しません。 Space 間で
cache / pin / share できます。

### Kernel-minted ULID (発行後 immutable)

`deployment:` / `journal:` / `operation:` / `activation:` / `revoke-debt:` /
`approval:` / `share:`。 発行された ID は resource lifetime にわたって不変 で、
別 resource に再割当てしません。

### operator-controlled 名 (immutable、 rename 不可)

`space:` / `object:` / `exposure:` / `connector:` / `external-participant:` /
`group:`。 operator が作成時に名前を選び、 v1 では rename を サポートしませ ん。
将来の rename API は `CONVENTIONS.md` §6 RFC で alias 追加型 (履歴参照
を書き換えない) として導入する想定です。

### Deterministic composite ID (source ごとに stable)

`link:` と `generated:`。 source 入力 (link は consumer + slot、 generated は
owner + reason) から導出します。 projection を再実行しても同じ ID。 source
を消すと ID も消え、 kernel は削除済 composite ID を別 resource に
再利用しません。

## 予約 kind と future extension

上述の kind が v1 の **完全集合** です。 新 kind 追加 / 既存 kind の用途 変更 /
alias には `CONVENTIONS.md` §6 RFC が必須。

`<kind>:<suffix>` 形が kernel が認識する唯一の ID grammar です。 これに
合わない文字列は ID として無効で、 ID を受け取る全 surface (apply 入力、 storage
書込、 audit ingest、 CLI flag parse) で reject されます。

## Related architecture notes

- docs/reference/architecture/object-model.md
- docs/reference/architecture/space-model.md
- docs/reference/architecture/snapshot-model.md
- docs/reference/architecture/link-projection-model.md
- docs/reference/architecture/data-asset-model.md

## See also

- [Kernel HTTP API](/reference/kernel-http-api)

## 関連ページ

- [Closed Enums](/reference/closed-enums)
- [Connector Contract](/reference/connector-contract)
- [Storage Schema](/reference/storage-schema)
- [Digest Computation](/reference/digest-computation)
- [Actor / Organization Model](/reference/actor-organization-model)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export and Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Cost Attribution](/reference/cost-attribution)
- [Quota Tiers](/reference/quota-tiers)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Zone Selection](/reference/zone-selection)
