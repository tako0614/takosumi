# Kernel Deploy System

> **Internal implementation**
>
> このページは takosumi kernel deploy system の internal 実装を説明する。
>
> - public contract: [manifest spec](/reference/manifest-spec) /
>   [Kernel HTTP API](/reference/kernel-http-api)
> - Installable App Model の入口は kernel の外側:
>   [Installable App Model](https://github.com/tako0614/takos-ecosystem/blob/master/docs/platform/installable-app-model.md)

takosumi kernel の責務は compiled Shape manifest を `POST /v1/deployments`
で受け取り、Deployment / ProviderObservation / GroupHead / provider operation
evidence を作ることです。AppInstallation ownership、billing、Git URL install、
workflow execution、GitOps intent は kernel の外側にあります。

本ページは kernel 境界と内部 record を説明します。Install / upgrade / GitOps は
kernel request に到達する前の upstream context としてだけ扱い、正本は Takosumi
Accounts docs と takosumi-git docs に置きます。

## 0. Deploy API と upstream lifecycle context

Installable App Model の upstream には、origin が異なる lifecycle path
が存在します。どの path も最終的には takosumi kernel の `POST /v1/deployments`
(= canonical deploy API / compute apply) に着地しますが、**install / upgrade /
GitOps intent** と **kernel deploy** は別の surface です。

| # | path                      | trigger                                   | 主体                             | 用途                             |
| - | ------------------------- | ----------------------------------------- | -------------------------------- | -------------------------------- |
| 1 | **Install path**          | `POST /v1/installations` (新規 install)   | Takosumi Accounts + takosumi-git | App を新規に install する        |
| 2 | **Upgrade path**          | `POST /v1/installations/:id/upgrade`      | Takosumi Accounts + takosumi-git | source ref / manifest を更新する |
| 3 | **GitOps deploy binding** | Takos が deploy intent repo に `git push` | Takos → takosumi-git watcher     | Takos が自分の中から deploy する |

> **kernel 直叩きは canonical deploy API**
>
> 旧来の "CLI から直接 kernel に compiled manifest を投げる" 経路は、 operator /
> CI / custom automation が使える unmanaged deploy path として残します。
>
> - AppInstallation ownership を伴う install / upgrade は上記 3 path
>   のいずれかを通る
> - raw deploy は AppInstallation を作らない unmanaged deployment として扱う
> - kernel に `.takosumi/app.yml` を直接渡してはいけない
> - kernel は `app.yml` を解釈しない

3 path に共通する不変条件は次のとおりです。

- kernel は `compiled manifest` (= installer-only placeholder を取り除いた
  compute manifest) しか受け取らない
- `.takosumi/app.yml` (installer-bound) は **kernel に渡らない**。これは
  installer / preview / binding catalog のための surface
- `.takosumi/manifest.yml` は `workflowRef` や `${artifacts.*}` /
  `${bindings.*}` / `${secrets.*}` / `${installation.*}` / `${params.*}`
  を含み得る authoring manifest。kernel に届く前に `workflowRef` は strip され、
  unresolved installer-only placeholder は Accounts materialization 後の deploy
  request build でも残れば kernel request 前に失敗する。 kernel-owned
  `${ref:...}` / `${secret-ref:...}` は deploy route が解決する (詳細は
  [.takosumi/app.yml spec](https://github.com/tako0614/takosumi-git/blob/master/docs/reference/app-yml-spec.md)
  と [Manifest Reference](/reference/manifest-spec))

## 1. Install path context (Accounts / takosumi-git owned)

新規に bundled / third-party InstallableApp を Takosumi Account の Space に
入れる経路。operator-selected install UI URL (managed example:
`takosumi.cloud/install?git=...&ref=...`) の Git URL install 流入や
`takosumi-git install <git-url>` CLI、`POST /v1/installations` API がここに集約
されます。Takos product 自身は unique top consumer であり、この通常
InstallableApp path の対象ではありません。

### 1.1 Install pipeline 13 step

この一覧は kernel request に到達する前後の context です。canonical step は
[Installer Pipeline](https://github.com/tako0614/takosumi-git/blob/master/docs/architecture/installer-pipeline.md)
と AppInstallation status 遷移
[(Takosumi Accounts)](https://github.com/tako0614/takosumi-cloud/blob/master/docs/architecture/takosumi-accounts.md#ownership-ledger)
で詳細化します。 本ページでは kernel handoff の位置だけを示します。

```txt
1. Git URL 受信                   (takosumi-git API)
2. repository fetch               (shallow clone)
3. ref → commit SHA pin           (sourceCommit を確定)
4. .takosumi/app.yml parse        (InstallableApp v1 metadata + bindings)
5. .takosumi/manifest.yml parse   (authoring compute manifest)
6. install preview 生成           (publisher / commit / bindings / grants / cost)
7. user approve                   (preview を確認しないと進まない)
8. workflow sandbox 実行          (build phase に runtime secrets を渡さない)
9. artifact resolve               (image digest / asset URI を解決)
10. AppBinding provisioning plan  (identity.oidc@v1, database.postgres@v1, ...)
11. manifest compile              (workflowRef strip / unresolved placeholder reject)
12. kernel deploy                 (POST /v1/deployments で apply)
13. AppInstallation ready         (status: ready, runtimeBindingId を確定)
```

step 11 で **compiled manifest digest** が確定し、AppInstallation 行の
`compiledManifestDigest` 列に保存されます。kernel はこの digest と一致する
compiled manifest だけを apply します。Step 12 以降は本ページ後半で説明する
従来の Deployment / ProviderObservation / GroupHead の世界に入ります。

### 1.2 何が AppInstallation に保存されるか

step 13 で AppInstallation 行は `installing → ready` に遷移し、次の値が
**immutable** に pin されます。

- `sourceGitUrl` / `sourceRef` / `sourceCommit`
- `appManifestDigest` (`.takosumi/app.yml` の digest)
- `compiledManifestDigest` (kernel に渡した compute manifest の digest)
- `mode` (shared-cell / dedicated / self-hosted)
- `runtimeBindingId` (どの cell / runtime に bind されたか)

これにより、後から「何を install したか」を AppInstallation 行と
InstallationEvent ledger だけで完全に再構築できます。詳細な field は
[Takosumi Accounts ownership ledger](https://github.com/tako0614/takosumi-cloud/blob/master/docs/architecture/takosumi-accounts.md#ownership-ledger)
を参照。

## 2. Upgrade path (source ref を更新)

既存 installation の source ref / `.takosumi/app.yml` / `.takosumi/manifest.yml`
を更新する経路。**install path と同じ pipeline を再走** し、新しい compiled
manifest digest を作って kernel に apply する点で構造的に install path
と同一です。

```bash
takosumi-git upgrade inst_abc --ref v1.2.4
```

差分は以下:

- step 7 の `install preview` は **upgrade preview** として manifest diff /
  permission diff / migration plan を提示する
- AppInstallation 行は新しい `sourceCommit` / `appManifestDigest` /
  `compiledManifestDigest` で **更新される** (新規 row は作らない)
- 旧 compiled manifest digest は **rollback 用に保存** され、
  `takosumi-git rollback inst_abc --to v1.2.3` で前の digest に戻せる

upgrade / rollback の UI / 仕様は
[Upgrade / Export](https://github.com/tako0614/takos/blob/master/docs/platform/upgrade-export.md)
を参照。

## 3. GitOps deploy binding (Takos が deploy intent を出す)

Takos 自身が "何かを deploy したい" と判断したとき (例: ユーザーが Takos 内の
sub-app を作る、agent が新しい worker を立てる) には、**Takos は kernel API を
直接叩きません**。代わりに **GitOps deploy binding** (`deploy-intent.gitops@v1`)
を使い、deployment intent を Git repo に commit / push するだけにします。

### 3.1 流れ

```txt
Takos (Installed)
  │
  │ 1. deployment intent (manifest YAML) を生成
  │
  ▼
DEPLOY_INTENT_REMOTE (= installation 専用 Git repo)
  │
  │ 2. git push (DEPLOY_INTENT_TOKEN で auth)
  │
  ▼
takosumi-git watcher
  │
  │ 3. push を検知 → installer pipeline を再走 (workflow / compile)
  │
  ▼
takosumi kernel
  │
  │ 4. compiled manifest を apply
  │
  ▼
新 / 更新された Deployment record (group ごと)
```

### 3.2 Takos が知らなくていい env list

GitOps deploy binding を採用すると、Takos の runtime 依存は次の env のみに
なります (詳細は
[Binding Catalog § deploy-intent.gitops@v1](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/binding-catalog.md)
を参照)。

```env
DEPLOY_INTENT_DRIVER=gitops
DEPLOY_INTENT_REMOTE=https://git.operator.example/installations/inst_abc/deployments.git
DEPLOY_INTENT_BRANCH=main
DEPLOY_INTENT_TOKEN=...
```

逆に Takos が **知らないもの** (= runtime 依存に **入れない** もの):

- takosumi kernel の endpoint や auth token
- provider credential (Cloudflare API token / AWS keys / 等)
- operator internal deployment token
- Takosumi Accounts internal API
- operator BillingPort API

つまり Takos は kernel client / Takosumi 専用 SDK ではなく、**「Git に intent
を書く app」** として完結します。Git が契約書、manifest が設計図、takosumi-git
が大工、kernel が工事現場、という分業が成立します。

### 3.3 budget guard

GitOps binding を経由する deploy intent も、Takosumi Accounts の budget guard
で高額操作を止められます。

```txt
Takos wants to create:
  GPU worker
Estimated cost:
  ¥1,200 / day

Approve?
```

普段の UX を壊さず、高額操作のみ user 確認を挟む設計です (本書 / ROADMAP)。

## 4. compiled manifest と app.yml の役割分離

3 path に共通する **設計の核** は、`.takosumi/app.yml` と
`.takosumi/manifest.yml` を厳格に分離することです。

| ファイル                 | 受領者                 | 解釈タイミング             | 内容                                                               |
| ------------------------ | ---------------------- | -------------------------- | ------------------------------------------------------------------ |
| `.takosumi/app.yml`      | takosumi-git installer | install / upgrade pipeline | InstallableApp v1 metadata + bindings + permissions                |
| `.takosumi/manifest.yml` | takosumi-git compiler  | compile 前                 | compute resource declaration (workflowRef / placeholder 込み)      |
| compiled manifest        | takosumi kernel        | `POST /v1/deployments`     | workflowRef / installer-only placeholder を含まない Shape manifest |

- `.takosumi/app.yml` は **kernel に渡してはいけない**。kernel は
  `identity.oidc@v1` のような binding type を **知らない**。
- `.takosumi/manifest.yml` は `${bindings.*}` / `${secrets.*}` /
  `${artifacts.*}` / `${installation.*}` / `${params.*}` と `workflowRef`
  を含み得ます。これらは **そのまま kernel に渡してはいけない**。
- kernel が apply するのは **compiled manifest** です。image digest / OIDC
  client / AppInstallation 値など installer-only の値は Accounts materialization
  後の deploy request build でも unresolved なら kernel request 前に
  失敗します。 resource 間参照 (`${ref:...}` / `${secret-ref:...}`) と Shape
  output resolution だけが kernel deploy route の責務として残ります。

field 定義は
[.takosumi/app.yml spec](https://github.com/tako0614/takosumi-git/blob/master/docs/reference/app-yml-spec.md)、placeholder
文法と binding 種別は
[Binding Catalog](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/binding-catalog.md)、Compiler
の動きは
[Installer Pipeline](https://github.com/tako0614/takosumi-git/blob/master/docs/architecture/installer-pipeline.md)
を参照。

## 5. 共通基盤: Deployment と Shape resource

upstream path のいずれを通っても、kernel に apply された後の状態は takosumi
kernel の Deployment lifecycle に集約されます。current authoring surface は
`apiVersion: "1.0"` + `kind: Manifest` + `resources[]` の Shape model です。旧
AppSpec の `components` / `routes` / `bindings` / `publications` は current
manifest ではありません。

- **Deployment** — input manifest、resource DAG、provider operation、 conditions
  / WAL を 1 lifecycle として扱う中核 record
- **ManifestResource** — `shape` / `name` / `spec` と optional `provider` hint
  を持つ apply 単位。例 `worker@v1` / `web-service@v1` / `database-postgres@v1`
- **ProviderObservation** — provider 側の observed state を separate stream
  として記録 (canonical な真値ではない)
- **GroupHead** — group ごとの `current_deployment_id` /
  `previous_deployment_id` pointer。Installable App Model では AppInstallation
  側の `compiledManifestDigest` が上位の source pin になる

`ResourceInstance` / `MigrationLedger` のみ Deployment 外の独立 record として
durable state を持ちます。group に所属しているかどうかで shape / provider の
apply semantics は変わりません。

> 現行実装の split status は
> [Current Implementation Note](/reference/architecture/index#deploy-shell)
> を参照

## 6. Manifest format (Shape model)

`.takosumi/manifest.yml` は authoring compute manifest です。top-level envelope
は compiled manifest と同じ closed set ですが、kernel 到達前に `workflowRef` と
installer-only placeholder を strip / materialize します。kernel が受け取るのは
compiled Shape manifest だけです。

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: worker@v1
    name: web
    provider: "@takos/cloudflare-workers"
    spec:
      artifact:
        kind: js-bundle
        hash: PLACEHOLDER
      compatibilityDate: "2026-05-09"
      routes:
        - my-app.example.com/*
    workflowRef:
      file: build.yml
      job: build-worker
      artifact: bundle
      target: spec.artifact.hash
```

`workflowRef` は takosumi-git の authoring extension です。kernel に到達する
前に artifact hash / URI が `workflowRef.target` に書き込まれ、`workflowRef`
field は削除されます。

container service と database の例:

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: api
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/aws-rds"
    spec:
      version: "16"
      size: small

  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:0123456789abcdef
      port: 8080
      scale: { min: 1, max: 3 }
      env:
        DATABASE_URL: ${ref:db.connectionString}
        DB_PASSWORD: ${secret-ref:db.passwordSecretRef}
```

normative な field 仕様は [manifest spec](/reference/manifest-spec)、Installable
App Model 上の二段構造は
[Installable App Model § 2 つの manifest](https://github.com/tako0614/takos-ecosystem/blob/master/docs/platform/installable-app-model.md)
を参照。

## 7. Shape model

### ManifestResource

`resources[]` の各 entry は `ManifestResource` です。`shape` は portable
resource contract、`spec` は shape 固有の desired state です。`provider` は
optional placement hint で、指定時はその provider が shape
を実装し、`requires[]` を 満たすことを constraint として検証します。省略時は
operator policy / provider registry が resolved provider を決めます。

### Resource wiring

resource 間 dependency は `${ref:<resource>.<field>}` /
`${secret-ref:<resource>.<field>}` で表現します。kernel は参照を DAG edge
として扱い、cycle を reject し、topological order で apply します。

### Entry points

top-level `routes[]` はありません。HTTP / public entrypoint は shape spec または
`custom-domain@v1` resource で表現します。

```yaml
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/aws-fargate"
    spec:
      image: ghcr.io/example/api@sha256:0123456789abcdef
      port: 8080
      scale: { min: 1, max: 3 }

  - shape: custom-domain@v1
    name: api-domain
    provider: "@takos/cloudflare-dns"
    spec:
      name: api.example.com
      target: ${ref:api.url}
```

Worker route patterns are strings in `worker@v1.spec.routes`.

### Namespace exports

External / operator-owned dependency は namespace export と account API /
BillingPort で表現します。consumer manifest に `imports[]` /
`serviceResolvers[]` は書きません。OIDC / billing / dashboard / deploy API など
は `operator.identity.oidc` / `operator.billing.default` のような export を
installer / account plane が explicit grant として扱います。

### Installable App binding は別レイヤー

Installable App Model の `.takosumi/app.yml` の `bindings:` (`identity.oidc@v1`
/ `database.postgres@v1` 等) は installer-bound です。current takosumi-git は
unresolved `${bindings.*}` / `${secrets.*}` を kernel に渡さず、deploy request
build 後も残る場合は kernel request 前に失敗します。詳しくは
[Binding Catalog](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/binding-catalog.md)
を参照。

## 8. CLI / API

Takosumi kernel の canonical deploy API は `POST /v1/deployments` です。CLI は
compiled Shape manifest を explicit path で受け取り、同じ API に送る thin client
に留めます。

```bash
takosumi deploy ./manifest.yml                 # unmanaged deploy (no AppInstallation)
takosumi deployments get <deployment-id>       # deployment status / evidence
takosumi deployments plan ./manifest.yml       # non-mutating plan / validation
```

Git URL install / `.takosumi/` project layout / workflowRef 解決は kernel CLI
ではなく `takosumi-git` の責務です。 AppInstallation 作成は Takosumi Accounts
の責務です。Takos product docs に残る `takos deploy` / `takos install` は
migration window 中の Takos compatibility surface であり、この kernel reference
の public API では ありません。

通常の install path:

- 一般ユーザー: `Use Takos` / `Install from Git` (Takos + Takosumi Accounts)
- 開発者: `takosumi-git install <git-url>` または operator install UI
- raw deploy: `takosumi deploy <manifest>` / `POST /v1/deployments`
  (AppInstallation ownership なし)
- 詳細:
  [Install Paths](https://github.com/tako0614/takos/blob/master/docs/apps/install-paths.md)
  /
  [takosumi-git installer pipeline](https://github.com/tako0614/takosumi-git/blob/main/docs/architecture/installer-pipeline.md)

個別 resource / deployment projection の管理 API は backend materialization
detail であり、current kernel manifest format には group inventory
操作を書きません。

## 9. Group features

Group と primitive projection record の責務は次のように分ける。

- ManifestResource は shape と resolved provider decision を持つ deployment
  operation として保存される
- worker route / provider domain / `custom-domain@v1` は routing projection に
  materialize される
- resource output と binding evidence は output planner / WAL / resource
  metadata に保存される
- group は `groups` row として inventory / source metadata / current deployment
  pointer / reconcile status を持つ compatibility projection
- deployment history / rollback / uninstall は group inventory に対する
  機能であり、primitive runtime の特別処理ではない

```text
group "my-app":
  groups row:
    inventory / source metadata / GroupHead pointer / reconcile status
  group features:
    deploy (resolve + apply) / deployment history / rollback / uninstall
  inventory:
    resource: web (worker@v1)
    resource: db (database-postgres@v1)
    resource: domain (custom-domain@v1)

group なし primitive:
  resource: shared-db
  custom-domain: redirect.example.com
```

## 10. Deploy pipeline (kernel apply の内部)

`POST /v1/deployments` が public deploy entrypoint。CLI / takosumi-git /
operator script は同じ API を呼ぶ client です。pipeline は Deployment lifecycle
(`preview` → `resolved` → `applying` → `applied` / `failed` / `rolled-back`) を
1 record で表現する。

1. **Authoring expansion**
   - deploy manifest envelope (`apiVersion: "1.0"` / `kind: Manifest`) を parse
   - bundled `template` があれば `resources[]` に展開する
   - kernel 到達時点で `workflowRef` や installer-only placeholder
     が残っていれば reject する
   - group が指定されている場合は group membership を付与する
2. **Resolution** (status → `resolved`)
   - `resources[]` の `shape` / optional `provider` hint / `requires[]` を
     catalog と provider registry で検証し、provider resolution を記録
   - `${ref:...}` / `${secret-ref:...}` を resource dependency edge
     として抽出し、 apply DAG を確定
   - resolution-gate の policy decision を `Deployment.policy_decisions[]`
     に記録
3. **Diff** (read-set validation)
   - 現在 GroupHead が指す Deployment desired resources と新 manifest の
     resources を比較
   - resource creation は resource API 側の責務として扱う
4. **Workload apply** (status → `applying`)
   - ManifestResource を dependency order で provider に apply
   - 各 provider operation は `Deployment.conditions[]` (scope.kind="operation"
     / "phase") に append される
5. **Managed-state sync**
   - provider outputs を validate し、`${ref:...}` / `${secret-ref:...}` の
     consumer resource spec を解決
6. **Routing reconcile**
   - workload apply と managed-state sync が成功した場合だけ worker routes /
     custom-domain resources / provider domains を reconcile
7. **Activation commit** (status → `applied`)
   - `Deployment.desired.activation_envelope` を commit、 GroupHead の
     `current_deployment_id` を新 Deployment に進め、 `previous_deployment_id`
     に旧 current を保持
   - group がある場合は group-scoped declaration / observed state / deployment
     pointer を更新する

## 11. Rollback

rollback は GroupHead の `current_deployment_id` を `previous_deployment_id`
(または明示指定された retained Deployment id) に向けて切り替える pointer move
です。 新 Deployment record は作成されず、 旧 current Deployment は
`rolled-back` status に遷移します。

- code + config + bindings が戻る (retained `Deployment.input.manifest_snapshot`
  と `Deployment.resolution.descriptor_closure` を再利用)
- DB data は戻らない (forward-only migration、 `MigrationLedger` は逆方向
  に進まない)
- resource の data / schema は自動巻き戻ししない
- group なし primitive の個別 rollback は、 その primitive API の contract
  に従う

Installable App Model 配下の **AppInstallation rollback**
(`takosumi-git rollback
inst_abc --to v1.2.3`) は、これとは別レイヤーで、過去の
compiled manifest digest を再 apply することで実現されます (詳細は
[Upgrade / Export](https://github.com/tako0614/takos/blob/master/docs/platform/upgrade-export.md))。

## 12. Install / version / source tracking

Installable App Model では source tracking の正本は `.takosumi/app.yml` と
AppInstallation 行です。Store / catalog は Git URL と immutable ref を解決し、
takosumi-git installer pipeline に渡します。

repo deploy / install の version は catalog が解決する Git ref / tag
が基準です。 `.takosumi/manifest.yml` に top-level `version` field
はありません。display version は release tag、catalog metadata、または
`.takosumi/app.yml` の metadata から導きます。

```yaml
# .takosumi/app.yml
apiVersion: app.takosumi.dev/v1
kind: InstallableApp
source:
  git: https://github.com/example/my-app
  ref: v1.2.0
  commit: 0123456789abcdef0123456789abcdef01234567
```

group がある場合も、source 情報は AppInstallation ledger または unmanaged
deployment metadata に保存します。

- `local`: `takosumi deploy <manifest>` / direct `POST /v1/deployments` で
  unmanaged deploy
- `repo:owner/repo@v1.2.0`: `takosumi-git` / Accounts installer pipeline が
  repo/ref を解決して compiled manifest を deploy

Installable App Model における source pin は AppInstallation 行の `sourceCommit`
/ `appManifestDigest` / `compiledManifestDigest` の 3 列で 表現されます (詳細は
[Takosumi Accounts ownership ledger](https://github.com/tako0614/takosumi-cloud/blob/master/docs/architecture/takosumi-accounts.md#ownership-ledger))。

## まとめ

```text
Kernel deploy boundary:

  Upstream lifecycle paths
    - Takosumi Accounts owns AppInstallation / install / upgrade
    - takosumi-git owns Git URL fetch / workflow / compile-strip
    - kernel receives only POST /v1/deployments

  Compiled manifest (kernel に渡る最終形)
    - workflowRef は strip 済み
    - ${bindings.*} / ${secrets.*} / ${artifacts.*} / ${installation.*} は残らない
    - ${ref:...} / ${secret-ref:...} は kernel deploy route が扱う
    - ${imports.*} は removed placeholder なので残らない
    - kernel は app.yml を解釈しない

  Core records (kernel 内部)
    - Deployment (input / resolution / desired / conditions)
    - ProviderObservation (observed state stream)
    - GroupHead (current / previous deployment pointer)
    - ResourceInstance / MigrationLedger (durable state)

  Shape authoring surface
    - resources[] (worker / web-service / database-postgres / object-store / custom-domain / ...)

  Optional group scope
    - groups row
    - features: deploy / history / rollback / uninstall
```

## 次に読むページ

- [Installable App Model](https://github.com/tako0614/takos-ecosystem/blob/master/docs/platform/installable-app-model.md)
  — 全体像と product / layer 責務分離
- [Installer Pipeline](https://github.com/tako0614/takosumi-git/blob/master/docs/architecture/installer-pipeline.md)
  — 13 step の install pipeline 詳細
- [AppInstallation 台帳](https://github.com/tako0614/takos-ecosystem/blob/master/docs/platform/app-installation.md)
  — source pin と status 遷移
- [.takosumi/app.yml spec](https://github.com/tako0614/takosumi-git/blob/master/docs/reference/app-yml-spec.md)
  — installer-bound manifest
- [Binding Catalog](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/binding-catalog.md)
  — 6 種の installer-bound AppBinding type
- [Install API](https://github.com/tako0614/takos-ecosystem/blob/master/docs/reference/install-api.md)
  — `POST /v1/installations` 等
- [Upgrade / Export](https://github.com/tako0614/takos/blob/master/docs/platform/upgrade-export.md)
  — upgrade / rollback / export
- [deploy CLI ガイド](https://github.com/tako0614/takos/blob/master/docs/deploy/deploy.md)
  — operator / internal context での deploy
