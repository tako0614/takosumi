# Provider Plugins

> このページでわかること: bundled provider plugin の一覧と対応 component kind。

**provider plugin** は AppSpec の
[component kind](./kind-catalog.md#component-kinds) を具体的な cloud / local
backend 上に materialize する。 各 plugin は実装する kind、サポートする
capability vocabulary、 kernel が OperationPlan 実行中に呼ぶ apply / destroy /
status lifecycle を宣言する。

Takosumi は out of the box で **21 個の provider plugin** を ship する。 20 は
default で配線され、1 個 (`@takos/deno-deploy`) は opt-in。 plugin は paper-thin
な lifecycle client であり、 credential、cloud SDK code、副作用はすべて
**runtime-agent** の背後に住む。 provider identity は `connector:<id>`
として識別する。 operator が agent 上で connector を install / control
するため、ある deployment から到達可能な provider は operator が所有する
(operator-installed / operator-controlled は意図的)。

Source roots:

- `packages/contract/src/provider-plugin.ts` — public `ProviderPlugin` contract
  と `KernelPlugin` interface (= `name` / `version` / `provides[]` (kind URI) /
  `capabilities` / `apply` / `destroy` / install/deployment hook)。
- `packages/plugins/src/kinds/<kind>.ts` — bundled component kind schema /
  outputs。
- `packages/<cloud>-providers/src/<kind>-<provider>.ts` — operator-facing
  `KernelPlugin` factory (`createPaaSApp({ plugins: [...] })` に直接渡せる plain
  function)。 operator は env から credential を読んで factory に渡す。 cloud
  別に 6 package
  (`@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-providers`)
  に分離されており、 operator は使う cloud だけを import する。

## Capability vocabulary: open string + reserved prefix

capability は **open string**。 provider は `capabilities` 配列に任意の
kebab-case 識別子を宣言でき、 AppSpec は任意の識別子を `requires` で参照できる。
selection は subset 所属だけをチェックする: provider が selectable なのは
`requires ⊆ capabilities` の場合に限る。

global vocabulary を一貫させるため、3 prefix が **reserved**。

| Prefix       | Owner                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `takos.*`    | consumer-application reserved namespace (e.g. Takos product surface); kernel assumes no Takos-specific semantics |
| `system.*`   | Takosumi kernel / runtime-agent / observation tier                                                               |
| `operator.*` | Operator-defined deployment-local capabilities                                                                   |

bare identifier (no `.`) は任意 provider が宣言できる **general capability**。
新 reserved prefix の追加は `CONVENTIONS.md` §6 RFC で governed され、 kernel
coordination を要する。 既存 reserved prefix 内では、 `takos.*` / `system.*`
下の識別子追加も §6 RFC を通る。 `operator.*` は自 deployment 内で operator
が自由に定義できる。

## Bundled provider catalog

同梱されている 21 個の provider をクラウド別にグルーピング。 すべて
`@takos/<cloud>-*` 形式の id を持つ。 component kind と capability 集合は
`packages/<cloud>-providers/src/<kind>-<provider>.ts` の各 factory と完全に
一致する。 **extension policy** 列は、サードパーティが標準の provider PR
フローで capability を追加してよいか (extensible)、 あるいは in-tree provider
内で capability 集合が閉じているか (closed-within-provider) を示す。

### AWS

| provider id          | component kind  | declared capabilities                                                                                                                   | extension policy |
| -------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@takos/aws-s3`      | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` | extensible       |
| `@takos/aws-fargate` | `worker`        | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        | extensible       |
| `@takos/aws-rds`     | `postgres`      | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   | extensible       |
| `@takos/aws-route53` | `custom-domain` | `wildcard`, `auto-tls`, `sni`, `alpn-acme`                                                                                              | extensible       |

### GCP

| provider id            | component kind  | declared capabilities                                                                                                                   | extension policy |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@takos/gcp-gcs`       | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` | extensible       |
| `@takos/gcp-cloud-run` | `worker`        | `always-on`, `scale-to-zero`, `websocket`, `long-request`                                                                               | extensible       |
| `@takos/gcp-cloud-sql` | `postgres`      | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   | extensible       |
| `@takos/gcp-cloud-dns` | `custom-domain` | `wildcard`, `auto-tls`, `sni`                                                                                                           | extensible       |

### Cloudflare

| provider id                   | component kind  | declared capabilities                                       | extension policy |
| ----------------------------- | --------------- | ----------------------------------------------------------- | ---------------- |
| `@takos/cloudflare-r2`        | `object-store`  | `presigned-urls`, `public-access`, `multipart-upload`       | extensible       |
| `@takos/cloudflare-container` | `worker`        | `scale-to-zero`, `geo-routing`                              | extensible       |
| `@takos/cloudflare-workers`   | `worker`        | `scale-to-zero`, `websocket`, `long-request`, `geo-routing` | extensible       |
| `@takos/cloudflare-dns`       | `custom-domain` | `wildcard`, `auto-tls`, `sni`, `http3`                      | extensible       |

### Azure

| provider id                   | component kind | declared capabilities                                     | extension policy |
| ----------------------------- | -------------- | --------------------------------------------------------- | ---------------- |
| `@takos/azure-container-apps` | `worker`       | `always-on`, `scale-to-zero`, `websocket`, `long-request` | extensible       |

### Kubernetes

| provider id                    | component kind | declared capabilities                                          | extension policy |
| ------------------------------ | -------------- | -------------------------------------------------------------- | ---------------- |
| `@takos/kubernetes-deployment` | `worker`       | `always-on`, `websocket`, `long-request`, `private-networking` | extensible       |

### Deno Deploy (opt-in)

| provider id          | component kind | declared capabilities                          | extension policy |
| -------------------- | -------------- | ---------------------------------------------- | ---------------- |
| `@takos/deno-deploy` | `worker`       | `scale-to-zero`, `long-request`, `geo-routing` | extensible       |

### Selfhost

| provider id                      | component kind  | declared capabilities                                                                                            | extension policy       |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@takos/selfhost-filesystem`     | `object-store`  | `presigned-urls`                                                                                                 | closed-within-provider |
| `@takos/selfhost-minio`          | `object-store`  | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` | extensible             |
| `@takos/selfhost-docker-compose` | `worker`        | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       | extensible             |
| `@takos/selfhost-systemd`        | `worker`        | `always-on`, `long-request`                                                                                      | closed-within-provider |
| `@takos/selfhost-postgres`       | `postgres`      | `ssl-required`, `extensions`                                                                                     | closed-within-provider |
| `@takos/selfhost-coredns`        | `custom-domain` | `wildcard`                                                                                                       | closed-within-provider |

## Selection rule

AppSpec component ごとに、kernel は provider hint が一致 (set されているとき)
し、かつ `capabilities` が `requires` の superset である plugin を選ぶ。
宣言集合が `requires` を満たさない provider を指名する request は、 apply
lifecycle が走る前の validation 時点で reject される。

## Deno Deploy opt-in flow

`@takos/deno-deploy` は default factory output から除外されている。 online 化は
2 ステップ。

1. **runtime-agent に connector を register**。 agent host で
   `TAKOSUMI_AGENT_DENO_DEPLOY_TOKEN` (および optional
   `TAKOSUMI_AGENT_DENO_DEPLOY_ORG`、`TAKOSUMI_AGENT_DENO_DEPLOY_PROJECT`) を
   set して、 agent の `ConnectorBootOptions` が起動時に Deno Deploy connector
   を resolve するようにする。 credential は agent だけが保持し、kernel は token
   を見ない。
2. **kernel 側で plugin を attach**。 operator は
   `createPaaSApp({ plugins: [denoDeployWorkerProvider({ token, organizationId }), ...] })`
   で `denoDeployWorkerProvider` factory を plain array に追加する。 plugin は
   `worker` kind に対して register され、AppSpec から selectable になる。

検証は `worker` component の provider hint を `@takos/deno-deploy` にして apply
を発行する。 kernel は apply lifecycle envelope を記録し、 agent は inject
された token を使って Deno Deploy API に forward し、 返ってきた `WorkerOutputs`
(`url`、`scriptName`、optional `version`) が apply result を通って戻る。

## Public API surface

operator-facing entry は **`createPaaSApp({ plugins })`** の plain array (= Vite
plugin pattern)。 各 plugin は `KernelPlugin` を返す factory function で、
provider lifecycle と install / deployment hook を 1 つの interface で表現する。

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";

const { app } = await createPaaSApp({
  plugins: [
    cloudflareWorkerProvider({ accountId, apiToken }),
    awsS3ObjectStoreProvider({ region, accessKeyId, secretAccessKey }),
  ],
});
```

`KernelPlugin` interface (= `packages/contract/src/plugin.ts`):

```ts
interface KernelPlugin {
  readonly name: string; // e.g. "@takos/cloudflare-workers"
  readonly version: string; // semver
  readonly provides: readonly string[]; // canonical kind URI(s)
  readonly capabilities: readonly string[];
  apply(spec, ctx): Promise<ApplyResult>;
  destroy(handle, ctx): Promise<void>;
  onInstallStart?(ctx): Promise<void>;
  onInstallComplete?(ctx): Promise<void>;
  onDeploymentStart?(ctx): Promise<void>;
  onDeploymentComplete?(ctx): Promise<void>;
}
```

bundled `kernelPluginFromProviderPlugin()` adapter は既存 `ProviderPlugin`
factory を `KernelPlugin` に lift する helper。 `PlatformContext` は
tenant-scoped secret store、 KMS port、 object storage port、 observability
sink、 publish / listen で resolve された material map を運ぶ。 plain array
attach は plugin marketplace / signed manifest fetch / port-based plugin host
を必要としない。

## Resolution Algorithm

> AppSpec component から provider を解決するアルゴリズム。

> **Scope note**: 本 section は kernel-internal provider resolution algorithm
> の記述です。 Takosumi の operator-facing public API surface は AppSpec /
> Installation / Deployment の 3 概念に閉じています (AGENTS.md mandate)。
> 以下に登場する「operator account-plane の Installation ledger」 等は
> takosumi-cloud reference operator distribution が保有する内部 entity の
> 振る舞いを説明するためのもので、 public concept ではありません。

AppSpec component から concrete deployment plan を生成する **provider
resolution** のアルゴリズムを定義します。AppSpec の `components.<name>.kind` と
optional provider hint を元に、operator policy / provider registry
が何を決めるかを明確にします。

### 1. Principle

`components.<name>.kind` が semantic contract です。provider hint は authoring
intent / placement hint であり、 component kind の意味を決める必須 field
ではありません。

provider resolution は次の問いに答える operator-controlled decision です。

```text
この Space で、この AppSpec component を、どの ProviderPlugin / runtime-agent
implementation で materialize するか。
```

kernel は provider を推測しません。 kernel は catalog / provider registry /
operator policy の入力を使って resolution を実行し、 結果を Deployment evidence
と audit に残します。

### 2. Inputs

Resolution input は次に閉じます。

- `componentName` — AppSpec component name (例: `web`)
- `kind` — component の semantic contract (例: `worker`)
- `spec` — component kind validator 済み desired state (例: `{ build, routes }`)
- `requires[]` — provider capability constraint (例: `["presigned-urls"]`)
- `providerHint` — optional authoring hint (例: `@takos/cloudflare-workers`)
- `spaceId` — Space catalog / policy の lookup key (例: `space_acme_prod`)
- `runtimeMode` — operator account-plane の Installation ledger entry 経由の
  場合の mode (例: `shared-cell`)
- `catalogRelease` — component kind / provider release pin (digest / release id)
- `operatorPolicy` — placement / region / quota / compliance rule (policy pack
  id + version)
- `costContext` — cost estimate と admission gate (plan / quota / billing
  account)
- `trustContext` — adopted release / implementation trust state (catalog digest
  pin state)

consumer manifest に endpoint URL、 service import、 anchor URL、 operator
hostname は書きません。 OIDC / billing / dashboard / deploy API は namespace
export / account API / OIDC discovery / BillingPort で扱います。

### 3. Output

Resolution output は `ResolvedProviderDecision` として Deployment evidence
に残す。

```ts
interface ResolvedProviderDecision {
  readonly resourceName: string;
  readonly kind: string;
  readonly providerId: string;
  readonly implementationId: string;
  readonly catalogReleaseDigest: string;
  readonly policyPackId: string;
  readonly policyPackVersion: string;
  readonly reason: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly decidedAt: string;
}
```

`reason` は人間が説明できる短い根拠です。 例:

```text
kind worker supported
requires js-bundle and edge-routes satisfied
space policy prefers cloudflare-workers in shared-cell
catalog release digest sha256:... verified
```

`constraints` は今後の drift / rollback / audit で再評価できる machine-readable
条件です。 `risks` は approval UI / policy decision に出す warning または error
です。

### 4. Algorithm

Resolution は fail-closed です。

1. AppSpec envelope / component schema を validate する。
2. Space に adopted な CatalogRelease を読む。
3. CatalogRelease の sha256 が operator-pinned `CATALOG_DIGEST` と一致することを
   verify する (publisher signing ではなく digest pin。 詳細は
   [Supply Chain Trust § 6](./supply-chain-trust.md#catalog-release-trust))。
4. `kind` を実装する provider candidates を provider registry から列挙する。
5. `requires[]` と provider capability を照合する。
6. `providerHint` がある場合は candidates をその provider に絞る。
7. operator policy で Space / runtime mode / region / quota / compliance を
   評価する。
8. 1 件に決まれば `ResolvedProviderDecision` を記録する。
9. 0 件なら reject。 複数件で priority が決まらなければ reject。

operator policy は deterministic でなければなりません。 同じ input digest に
対して別 provider を返す policy は invalid です。 policy を変える場合は policy
pack version を上げ、 Deployment evidence に新旧の decision を残します。

### 5. Failure Modes

- provider が component kind を実装しない: reject
- `requires[]` を満たせない: reject
- provider hint が Space policy で禁止: reject
- candidates が 0 件: reject
- candidates が複数で priority 不定: reject
- CatalogRelease trust failure: reject before side effect
- cost / quota / compliance gate failure: reject または approval-required risk

dev fallback は production で使ってはいけません。 production mode で必要な
catalog / provider registry / policy pack が無い場合は fail-closed です。

### 6. Audit

次の値は Deployment evidence / audit に残します。

- input manifest digest
- component name / kind / optional provider hint
- selected provider id / implementation id
- CatalogRelease digest
- policy pack id / version
- decision reason / constraints / risks
- actor / Space / timestamp

provider resolution は service discovery ではありません。 endpoint URL を audit
して provider を信頼する仕組みではなく、 catalog と policy に基づく placement
decision を記録する仕組みです。

### 7. Non Goals

- consumer manifest の endpoint URL 記述
- endpoint discovery による provider switching
- operator policy による component kind semantics の変更

Component kind の意味は contract package / component kind catalog が持ち、
provider resolution はその kind をどこでどう実装するかだけを決めます。

## Implementation Contract

> provider Implementation が runtime-agent に対して守るべき wire-level lifecycle
> contract。

[Runtime-Agent API](./runtime-agent-api.md) は kernel ↔ runtime-agent の HTTP
RPC envelope、 [Connector Contract](./connector-contract.md) は `connector:<id>`
の identity / accepted-kind vector を扱います。 本 section は その中間で、
Implementation が runtime-agent dispatcher から受け取る request / response
envelope、 返すべき closed status enum、 effect bound、 recovery /
dry-materialization / verify 動作を規定します。

contract は wire 形のみを縛り、 packaging は自由 (Deno module / バイナリ / HTTP
service / WASM / container いずれも可)。 dispatcher が下記 envelope を呼 出に
realize できる限り適合します。

### Operation request envelope

runtime-agent は次の envelope で Implementation を呼び出します。 field 順は
normative。 欠落 field は省略ではなく明示的 null とします。

```yaml
OperationRequest:
  spaceId: space:<name>
  operationId: operation:<ulid>
  operationAttempt: integer >= 1
  journalCursor: journal:<ulid>
  idempotencyKey: <opaque string>
  desiredGeneration: integer >= 1
  desiredSnapshotId: desired:<sha256>
  resolutionSnapshotId: resolution:<sha256>
  operationKind: <enum>
  inputRefs: [<id>, ...]
  preRecordedGeneratedObjectIds: [generated:..., ...]
  expectedExternalIdempotencyKeys: [<opaque string>, ...]
  approvedEffects: [<closed effect descriptor>, ...]
  recoveryMode: normal | continue | compensate | inspect
  walStage: prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
  deadline: <RFC 3339 timestamp>
```

Field semantics:

- `operationAttempt` increments on every retry of the same `operationId`. The
  Implementation must treat all attempts of the same `operationId` as the same
  logical operation.
- `journalCursor` is the WAL cursor at which this attempt was dispatched. It is
  informational; the Implementation does not write the WAL itself.
- `idempotencyKey` is derived from
  `(spaceId, operationPlanDigest, journalEntryId)` (see
  [WAL Stages — Idempotency key](./wal-stages.md#idempotency-key)). The same key
  always implies the same expected effect digest.
- `desiredGeneration` is the monotonically increasing generation of the Space's
  DesiredSnapshot. Implementations use it to detect that a prior in-flight
  operation was superseded.
- `inputRefs` lists the resolved object / generated / link IDs the
  Implementation may read from.
- `preRecordedGeneratedObjectIds` lists
  `generated:<owner-kind>:<owner-id>/<reason>` IDs the kernel has already
  minted; the Implementation must use those exact IDs when it reports
  `generatedObjects[]`.
- `expectedExternalIdempotencyKeys` lists the external API idempotency keys the
  kernel expects the Implementation to forward to its connector.
- `approvedEffects` is the closed bound the apply pipeline obtained through
  approval. The Implementation must not exceed it.
- `recoveryMode` selects how the Implementation should treat partial prior state
  (see below).
- `walStage` is the stage on whose behalf this dispatch runs. The Implementation
  does not advance WAL stages itself.
- `deadline` is an absolute deadline, not a duration. The Implementation must
  abort and return `failed` with a `retryable` error before the deadline
  elapses.

> v1 bridge: installer lifecycle は WAL stage を記録後、 operation tuple を
> `PlatformContext.operation` として provider 呼出に渡します。 runtime-agent
> backed provider は `LifecycleApplyRequest` /
> `LifecycleDestroyRequest.idempotencyKey`、 `operationRequest`、
> `metadata.takosumiOperation` として forward。 `LifecycleCompensateRequest` は
> reverse effect 用で、 専用 operation 不在時は handle-keyed `destroy` に
> fallback。 v1 の `operationRequest` projection は WAL 座標 / idempotency key /
> recovery mode / 予想される外部 request token / `walStage` を運びます。 非空
> `approvedEffects` / pre-recorded 生成 object ID のような未導出 field
> は明示的に空配列として送られます。

### Operation result envelope

Implementation は次の envelope を返します。 生成しない field は省略ではなく
明示的な空配列とします。

```yaml
OperationResult:
  operationId: operation:<ulid>
  status: succeeded | failed | partial | requires-approval | compensation-required
  actualEffects: [<closed effect descriptor>, ...]
  generatedObjects: [{ id: generated:..., ... }, ...]
  secretRefs: [<secret partition handle>, ...]
  endpointRefs: [<endpoint descriptor>, ...]
  grantHandles: [<grant descriptor>, ...]
  observations: [<observation tuple>, ...]
  retryHint: { retryable: bool, after: <duration?>, reason?: <code> }
  compensationHint: { kind: <enum>, debt?: <descriptor> }
  errorCode: <LifecycleErrorBody code | DomainErrorCode | connector-extended:* | null>
  walStageAck: prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
```

Implementation は新規 identity prefix を発明しません。 request で供給された ID
(`operationId`、 `preRecordedGeneratedObjectIds`) を verbatim にエコーします。

### Operation status enum (5 values)

`status` は closed な 5 値 enum。 apply pipeline が依存する厳密な semantic を
持ちます。

| Status                  | Meaning                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `succeeded`             | The operation completed and `actualEffects` is final.                                                                            |
| `failed`                | The operation could not proceed; the WAL stage transitions to `abort`.                                                           |
| `partial`               | Some effects materialized but more work is needed; the kernel may dispatch a follow-up attempt.                                  |
| `requires-approval`     | The Implementation discovered an effect that needs explicit approval; the apply pipeline pauses and surfaces a Risk.             |
| `compensation-required` | Prior partial state must be rolled back; the WAL stage transitions to `abort` and `compensationHint` drives compensate recovery. |

非終端 status は `partial` のみ。 他 4 つは現 attempt の終端で、 apply pipeline
は必要に応じて approval / compensation を再解決した後にのみ新規 attempt
を再スケジュールします。

### Recovery mode behaviour

`recoveryMode` は事前状態についての前提を伝える closed 4 値 enum です。

- `normal`: no prior partial state exists; the Implementation acts as if this is
  a first attempt for the `idempotencyKey`.
- `continue`: a prior attempt for the same `idempotencyKey` made forward
  progress; the Implementation must finish it idempotently and return the same
  effect digest as the prior attempt would have.
- `compensate`: prior partial state must be rolled back; the Implementation must
  reverse `actualEffects` it has already reported under the same
  `idempotencyKey`. Effects that cannot be reversed surface as
  `compensation-required` with a populated `compensationHint.debt` so the kernel
  can enqueue a RevokeDebt entry.
- `inspect`: the Implementation must report observed external state without
  performing any mutating call. This mode is used by `actual-effects-overflow`
  triage and by recovery dry-runs.

`inspect` mode は現 stage を超えて WAL を進めません。 Implementation は観測
した外部状態を反映した `actualEffects` と、 入力の `walStage` と等しい
`walStageAck` を持つ `succeeded` を返します。

### Effect bound rule

Implementation は次の invariant で動作します。

```text
actualEffects ⊆ approvedEffects
```

Implementation は外部 mutation 前に intended effect 集合を計算し、
`approvedEffects` を逸脱するなら処理を拒否しなければなりません。 外部実状態の
乖離で `approvedEffects` 外の effect を生成したと気付いた場合は次を行います:

1. Stop further mutation.
2. Return `status = failed` with `errorCode = actual-effects-overflow`.
3. Populate `actualEffects` with the full observed effect set, including the
   overflow.
4. Set `compensationHint.kind = overflow` so the apply pipeline can schedule
   compensate recovery.

`actual-effects-overflow` は closed Risk ([Risk Taxonomy](./risk-taxonomy.md)
参照)。 kernel はこれに応じて `approvedEffects` を黙って広げません。

### Dry materialization phase

apply pipeline は approval bind 前に各 Implementation に actual effect を予測
させます。 runtime-agent は通常の `OperationRequest` を次の制約で dispatch:

- `walStage = prepare`.
- `recoveryMode = inspect`.
- The Implementation must not perform any external mutation.
- The Implementation populates `actualEffects` with its **predicted** effect
  set.

kernel は [digest 計算ルール](./digest-computation.md) で予測集合を hash し、
OperationPlan の `predictedActualEffectsDigest` として bind します。 以降 の
`commit` / `post-commit` attempt はその digest に bound され、 逸脱は
`actual-effects-overflow` を引き起こします。

Dry materialization は contract 上 side-effect free。 決定的予測を生成できない
Implementation は説明的 `errorCode` 付き `status = requires-approval` を返し、
apply pipeline が plan-level Risk として surface します。

### Idempotency contract

単一 `idempotencyKey` について:

- The Implementation must produce the **same** `actualEffects` digest on every
  successful attempt. Returning a different digest under the same key is a
  hard-fail at the kernel; the apply pipeline rejects the result and refuses to
  advance the WAL.
- The Implementation must reuse `expectedExternalIdempotencyKeys` when
  forwarding mutations to its connector. Inventing new external keys defeats
  end-to-end idempotency.
- Retries for the same `idempotencyKey` carry incrementing `operationAttempt`
  values. The Implementation must not treat a higher attempt number as license
  to widen the effect set.

### Connector relationship

Implementation は外部 credential を保持しません。 mutate 呼出は
[Connector Contract](./connector-contract.md) で定義された operator install の
Connector 経由で行います。

- The active `connector:<id>` for the Implementation is part of the resolved
  `inputRefs` set; the runtime-agent supplies the resolved Connector record
  (`acceptedKinds`, `signingExpectations`, `envelopeVersion`) but never the
  Connector's credentials.
- DataAsset delivery to the Connector follows
  [DataAsset Kinds — accepted-kind vector](./kind-catalog.md#artifact-kinds) and
  is bound by the Connector's `acceptedKinds` vector. An Implementation that
  asks the Connector to accept a kind outside that vector receives an
  `artifact_kind_mismatch` failure that surfaces as
  `errorCode = artifact_kind_mismatch` in the OperationResult.
- Implementations consume artifact bytes by hash through the runtime-agent's
  artifact partition; the deploy bearer never reaches the Implementation.

### Verify operation

`POST /v1/lifecycle/verify` ([Runtime-Agent API](./runtime-agent-api.md) 参照)
は次の verify 形式 OperationRequest を dispatch:

- `operationKind = verify-object`.
- `walStage = prepare` (verify never advances the WAL).
- `recoveryMode = inspect`.

Implementation は Connector に対する read-only health check を行い、 次を返
します:

- 健全時: `status = succeeded` で `actualEffects` 空
- 不健全時: `status = failed` で `errorCode` を closed `LifecycleErrorBody` code
  に設定

verify は WAL entry を生成せず、 `approvedEffects` を広げず、 RevokeDebt も
queue しません。

### Failure mode to journal entry mapping

各終端 status は固定 WAL 遷移にマップされます。

| Status                  | WAL effect                                             | Journal entry recorded                                                               |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `succeeded`             | Stage advances to `walStageAck`.                       | Effect digest persisted; observations appended.                                      |
| `failed`                | Stage transitions to `abort`.                          | `errorCode` persisted; `compensationHint` informs the abort plan.                    |
| `partial`               | Stage retains current value; attempt counter advances. | Partial effects persisted; next attempt resumes from the same WAL cursor.            |
| `requires-approval`     | Stage transitions to `skip` for this attempt.          | Approval re-validation Risk surfaces; the apply pipeline waits for a fresh approval. |
| `compensation-required` | Stage transitions to `abort`.                          | RevokeDebt enqueued via `compensationHint.debt`; compensate recovery scheduled.      |

Implementation は WAL を直接書きません。 runtime-agent が OperationResult を
kernel に forward し、 WAL ledger の唯一の書き手は kernel です。

### Packaging freedom

上記 contract は wire 形のみを縛り、 実装言語 / runtime は縛りません。 適合
Implementation は次のいずれでも構いません:

- runtime-agent に in-process load される Deno module
- 安定した on-host transport (Unix domain socket / named pipe / stdio) で invoke
  される standalone binary
- trusted local network 越しに dispatch される remote HTTP service
- per-attempt instantiate される WASM module
- host-local container runtime で起動される container

runtime-agent dispatcher が各形式を envelope に適合させる境界です。 envelope /
status enum / effect bound / idempotency 規則を満たす限り適合します。

### Related architecture notes

- docs/reference/architecture/paas-provider-architecture.md
- docs/reference/architecture/implementation-operation-envelope.md
- docs/reference/architecture/runtime-deployment-model.md#operation-plan--write-ahead-journal
- docs/reference/architecture/policy-risk-approval-error-model.md
- docs/reference/architecture/namespace-export-model.md#data-asset-model

## Cross-references

- [Access Modes](./access-modes.md) — provider 管理 object が consumer に自身を
  expose する仕方を支配する closed v1 access mode enum (`read` / `read-write` /
  `admin` / `invoke-only` / `observe-only`)。
- [Artifact Kinds](./kind-catalog.md#artifact-kinds) — bundled DataAsset kinds
  (`oci-image` / `js-bundle` / `lambda-zip` / `static-bundle` / `wasm`) と
  provider が apply 時に受け取る registry。
- [Connector Contract](./connector-contract.md) — operator-installed connector
  identity (`connector:<id>`)、accepted-kind vector、Space visibility、signing
  expectations、provider が consume する envelope versioning。
- [Closed Enums](./closed-enums.md) — object lifecycle class と provider が
  output 発行時に尊重すべき closed enum。
- `CONVENTIONS.md` §6 RFC (takosumi repo root) — 新 reserved capability prefix
  の提案プロセス、 component-kind capability union への変更プロセス。

## 関連ページ

- [Kind Catalog](./kind-catalog.md#component-kinds)
- [Connector Contract](./connector-contract.md)
- [Access Modes](./access-modes.md)
