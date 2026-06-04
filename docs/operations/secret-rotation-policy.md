# Secret Rotation Policy

> このページでわかること: シークレットローテーションのガバナンスポリシー
> (頻度・監査・責任範囲)。

> **Document role**: 本文書は Takos secret rotation の **governance / contract**
> です。Takos operator が提供する保証 (rotation cadence、initiator、audit 要件、
> recovery contract) を定義します。実行手順 (_how_) は operational runbook
> [`./secret-rotation.md`](./secret-rotation.md) を参照してください。

## Scope

Takos の public source には production / staging の secret 値を置きません。
ownership boundary は以下に固定します:

- `takos/` は public contract、非機密の hosting expectation、release gate
  を文書化。
- operator runbook と secret inventory は `takosumi/docs/operations/` が所有。
  secret 値 / rotation evidence / private rollback note 自体は repo 外の operator
  vault (= operator host の `/root/.takos-secrets/<env>/` および承認済 run log)
  に置き、repo にはコミットしない。
- in-process deploy control (Takosumi) は OpenTofu run / workflow behavior
  を所有。 Takos 側で project-layout driven secret UX を増やさない。

本 policy はすべての Takos operated 環境に適用します。 Installation の OIDC
client secret track は in-process account plane で強制されます (下記参照)。

## Rotation Cadence

| Secret class                                                                                    | Default cadence | Maximum interval | Maintenance window required |
| ----------------------------------------------------------------------------------------------- | --------------- | ---------------- | --------------------------- |
| Platform keypair (`PLATFORM_PRIVATE_KEY`, `PLATFORM_PUBLIC_KEY`)                                | 12 months       | 18 months        | Yes                         |
| `ENCRYPTION_KEY`                                                                                | 12 months       | 18 months        | Yes (data re-encryption)    |
| `EXECUTOR_PROXY_SECRET`                                                                         | 6 months        | 12 months        | Production only             |
| `TAKOS_INTERNAL_API_SECRET`                                                                     | 6 months        | 12 months        | Production only             |
| OIDC client secrets (`OIDC_CLIENT_SECRET`)                                                      | 6 months        | 12 months        | No (issuer-coordinated)     |
| LLM / embedding provider keys                                                                   | 6 months        | 12 months        | No                          |
| Cloudflare API credentials (`CF_API_TOKEN`)                                                     | 6 months        | 12 months        | Production only             |
| Emergency rotation (suspected exposure, leaked credential, departed operator with prior access) | Immediate       | n/a              | Per-secret class            |

secret 種別ごとの個別 policy は `apps/control/secret-rotation.policy.json` に
あり、rotation runner が参照します。

## Who Can Initiate

| Action                                  | Authorized role                               |
| --------------------------------------- | --------------------------------------------- |
| Scheduled rotation (cadence-driven)     | On-call operator (primary or secondary)       |
| Emergency rotation (suspected exposure) | Any operator; incident commander notified     |
| OIDC client secret rotation             | In-process account plane (see below)          |
| Production maintenance-window rotation  | Release owner + on-call operator (two-person) |

## OIDC Client Secret Ownership

OIDC client secret は Takos が自前管理しません。Installable App Model では
**worker 内で in-process に動く account plane (Takosumi の
`createAccountsHandler`、issuer は bare origin)** が per-Installation で OIDC
client secret を発行・rotation します。Takos は `listen.oidc.path:
identity.primary.oidc` の materialization として `OIDC_CLIENT_SECRET` を runtime
に受け取るだけで、OAuth client registry / consent / token endpoint を持ちません
(see [../../../docs/reference/operator-account-plane-contract.md] /
[../../../takosumi/docs/reference/operator.md])。

in-process account plane の rotation contract:

- per-Installation で独立した client secret を発行する。
- rotation 時は new secret を resolved listen binding material に反映し、grace
  window (>=10 min) の間 old secret を併用可能にする。
- rotation 完了後、in-process account plane の audit event に rotation
  記録を残す。

## Audit Requirements

すべての rotation で以下を必ず生成します:

1. `PHASE-19-RUN-LOG.md` に日付、環境、secret class、実行コマンド、結果、
   rollback note を記録した run-log entry。
2. 該当する場合、private policy (`apps/control/secret-rotation.policy.json`) の
   `lastRotatedAt` evidence を更新。
3. OIDC client secret の場合、Installation id、旧 secret id、新 secret id、
   rotation timestamp をリンクした in-process account plane の audit event。
4. public / private を問わず、commit するファイルに secret 値、token body、key
   material、provider credential JSON を含めないこと。

## Escalation

| Trigger                                              | Escalation path                             |
| ---------------------------------------------------- | ------------------------------------------- |
| Rotation blocked by remote / local omission mismatch | Secondary on-call within 1 business hour    |
| Suspected secret exposure                            | Incident commander immediately (SEV-1 path) |
| OIDC issuer rotation API failure                     | in-process account plane owner immediately  |
| Cadence breach (overdue secret)                      | Release owner; block next promotion         |

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
- public な secret 所有ルールは `takos/docs/hosting/secrets.md` を参照。
- public 例は placeholder または fixture 専用の値に留めること。
- 実 rotation evidence は private run log のみに記録すること。

## Cross-References

- 実行手順 (operational runbook): [`./secret-rotation.md`](./secret-rotation.md)
- SEV 分類 (emergency rotation 用): [`./oncall.md`](./oncall.md)
- incident response (漏洩疑い時):
  [`./incident-response.md`](./incident-response.md)
