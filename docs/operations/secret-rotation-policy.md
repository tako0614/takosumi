# Secret Rotation Policy

> このページでわかること: シークレットローテーションのガバナンスポリシー
> (頻度・監査・責任範囲)。

> **Document role**: 本文書は Takosumi operated environment の secret rotation
> **governance / contract** です。Takosumi operator が提供する保証 (rotation cadence、initiator、audit 要件、
> recovery contract) を定義します。実行手順 (_how_) は operator 環境の private runbook に置き、public docs には
> secret 値や実 rotation evidence を置きません。

## Scope

Takosumi の public source、private deploy-state repo、docs には production /
staging の secret 値を置きません。ownership boundary は以下に固定します:

- `takosumi/docs/operations/` は public runbook と secret class contract を所有する。
- realized config は `takosumi-private/platform/wrangler.toml` が所有する。
- secret 値、rotation evidence、private rollback note は operator vault
  (`takosumi-private/.secrets/<env>/` または承認済み operator-local vault path)
  と private run log に置き、repo にはコミットしない。
- Takosumi control plane は OpenTofu Capsule Run、ProviderConnection、CredentialRecipe、ProviderBinding、
  Secret、credential mint audit、AuditEvent を所有する。

本 policy はすべての Takosumi operated 環境に適用します。既存実装の OIDC projection compatibility path は
migration debt です。final public model は Capsule/account-plane projection metadata であり、public PKCE client
metadata だけを扱い、client secret rotation track は持ちません。これは Capsule-projected service 向け identity projection であり、
任意 third-party client の login / consent platform としての secret lifecycle ではありません。

## Rotation Cadence

| Secret class                                                                                    | Default cadence | Maximum interval | Maintenance window required                   |
| ----------------------------------------------------------------------------------------------- | --------------- | ---------------- | --------------------------------------------- |
| Platform OIDC signing keypair (`TAKOSUMI_ACCOUNTS_ES256_*`)                                     | 12 months       | 18 months        | Yes                                           |
| Pairwise subject / launch / export secrets                                                      | 12 months       | 18 months        | Production only                               |
| Internal accounts/control-plane bearer or handshake token pair                                  | 6 months        | 12 months        | Production only                               |
| Upstream OAuth provider secrets                                                                 | 6 months        | 12 months        | No if client id unchanged                     |
| Takosumi Cloud payment processor secrets                                                        | 6 months        | 12 months        | Takosumi Cloud only                           |
| Operator default connection bootstrap credentials                                               | 6 months        | 12 months        | Production if plan/apply may mint credentials |
| Git / Cloudflare / AWS / GCP / GitHub / Kubernetes / generic ProviderConnection secrets         | 6 months        | 12 months        | Per ProviderConnection status                 |
| Emergency rotation (suspected exposure, leaked credential, departed operator with prior access) | Immediate       | n/a              | Per-secret class                              |

## Who Can Initiate

| Action                                                   | Authorized role                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Scheduled rotation (cadence-driven)                      | On-call operator (primary or secondary)                                             |
| Emergency rotation (suspected exposure)                  | Any operator; incident commander notified                                           |
| ProviderConnection / Capsule integration secret rotation | Takosumi operator, Workspace owner, or ProviderConnection owner, depending on scope |
| Production maintenance-window rotation                   | Release owner + on-call operator (two-person)                                       |

## Connection Token and OIDC Ownership

per-Capsule/account-plane OIDC projection は public PKCE client metadata です。Capsule-projected service へ
渡す material は issuer、client id、redirect URI、scope などの public metadata
に限り、client secret は発行・materialize しません。OAuth client registry /
consent / token endpoint は Takosumi accounts plane が所有しますが、generic
third-party login / consent product として前面に出すのは、client registry、
account session binding、consent UX、revocation policy が揃ってからにします。

Capsule consumer が `capsules:read` / `capsules:write` を使う場合、access token と
refresh token は発行先consumerのsecret storeに暗号化保存し、単一Workspace bindingと
一緒に扱います。refresh token rotation時は新tokenが返れば置換し、省略された場合は
現在のrefresh tokenを継続します。invalid/revoked responseでは両tokenを破棄し、ユーザーに
OIDC authorizationを再実行させます。共有operator tokenへ暗黙fallbackしません。

ProviderConnection / Capsule integration secret の rotation contract:

- source Git token、events webhook、showback usage report、operator extension token
  など secret-backed material は ProviderConnection / Secret / Run credential / Capsule integration secret
  のいずれかとして scope を固定する。
- raw token は rotation 時に一度だけ返し、通常の projection / GET response には
  expiry と non-secret metadata だけを出す。`secret_ref` / vault handle は public projection に出さない。
- rotation 時は new token を projection metadata に反映し、grace window (>=10 min)
  の間 old token を併用可能にする。
- rotation 完了後、AuditEvent に Workspace id、Project id / Capsule id (該当する場合)、
  ProviderConnection id / Secret ref、scope、旧 secret ref、新 secret ref、rotation timestamp を残す。
- Run credential の mint は secret rotation event ではなく、Run / AuditEvent
  に phase / provider / ProviderConnection id だけを non-secret audit として残す。
- ProviderConnection credential rotation は ProviderConnection / Secret rotation として扱う。
  secret-backed provider policy は provider binary trust record であり credential ではないため、token rotation で作り直さない。
- confidential OIDC client が必要な operator extension は public PKCE projection
  とは別の secret class としてこの policy に追加してから運用する。

## Audit Requirements

すべての rotation で以下を必ず生成します:

1. private run log に日付、環境、secret class、実行コマンド、結果、
   rollback note を記録した entry。
2. 該当する場合、operator vault の secret inventory / last rotated evidence を更新。
3. ProviderConnection / Capsule integration secret の場合、Workspace id、Project id / Capsule id (該当する場合)、
   ProviderConnection id / Secret ref、旧 secret ref、新 secret ref、rotation timestamp
   をリンクした AuditEvent。
4. public / private を問わず、commit するファイルに secret 値、token body、key
   material、provider credential JSON を含めないこと。

## Escalation

| Trigger                                                              | Escalation path                             |
| -------------------------------------------------------------------- | ------------------------------------------- |
| Rotation blocked by remote / local omission mismatch                 | Secondary on-call within 1 business hour    |
| Suspected secret exposure                                            | Incident commander immediately (SEV-1 path) |
| ProviderConnection / Capsule integration secret rotation API failure | Takosumi platform owner immediately         |
| Cadence breach (overdue secret)                                      | Release owner; block next promotion         |

secret 漏洩疑いの対応は
[`./oncall.md § SEV Classification`](./oncall.md#sev-classification) が定義する
SEV-1 path に従い、[`./incident-response.md`](./incident-response.md)
で処理します。

## Recovery Contract

| Target           | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| Rotation RTO     | <= 1 hour from decision to verified post-rotation status             |
| Rotation RPO     | 0 (rotation must not lose state; old secret retained until verified) |
| Rollback window  | <= 15 min after detection of post-rotation auth failure              |
| Evidence latency | <= 1 business day from rotation completion to run-log entry          |

## Public Guidance

- provider credential、live 値入り tfvars、Worker secret 値、API key、生成済み
  key material をコミットしないこと。
- host/distribution product の self-host secret guidance は各 product docs を参照。
- public 例は placeholder または fixture 専用の値に留めること。
- 実 rotation evidence は private run log のみに記録すること。

## Cross-References

- SEV 分類 (emergency rotation 用): [`./oncall.md`](./oncall.md)
- incident response (漏洩疑い時):
  [`./incident-response.md`](./incident-response.md)
