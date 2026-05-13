# Workflow Placement Rationale

> このページでわかること: workflow を kernel 外に置いた設計判断の根拠。

本ドキュメントは、**Takosumi の kernel に workflow 語彙が無い** 理由と、その代
わり workflow / cron / hook の関心事がどこに住むかを記録する。workflow 風自動 化
— スケジュールされたジョブ、ビルドパイプライン、デプロイフック、外部イベン
ト駆動の run — は **`takosumi-git`** が所有する。これは `takosumi` の姉妹プロ
ダクトで、kernel の上にあり、manifest を kernel に submit する。kernel 自身は
純粋な manifest deploy engine: `POST /v1/deployments` で closed な `Manifest`
envelope を受け取り、resource DAG を resolve して apply する。upstream client は
audit 用に不透明な deploy provenance を attach できるが、その provenance は
workflow 実行 contract ではない。

kernel は workflow primitive を一切同梱しない。workflow 形のものはすべて
`POST /v1/deployments` 境界の上に位置する `takosumi-git` に住む。

本書は設計層のみを扱う。

## 1. なぜ kernel 側 workflow primitive を組み込まないのか

Takosumi は常に kernel を薄い curation 層として位置付けてきた。curated な 5 つ
の shape (`object-store`、`web-service`、`database-postgres`、`custom-domain`、
`worker`) が kernel 所有なのは、これらが任意の `Space` operator が考えなくては
ならない PaaS primitive に対応するからである。workflow / cron / hook surface は
この集合には属さない。理由:

- **kernel の薄さ。** GitHub Actions / GitLab CI 型の実行グラフを kernel に
  埋め込むと、既存の apply DAG の上に job DAG / matrix / retry / concurrency
  semantics をモデル化する必要が生じる。これは同じ `WriteAheadOperationJournal`
  内に住む 2 つ目の scheduler である。2 つの DAG が 1 つの journal を共有する
  のは WAL stage enum の構造過負荷であり、双方の進化を妨げる。
- **curation の中立性。** catalog は意図的に小さく中庸である。組み込みの
  `workflow` shape は CI / cron / lifecycle の長い尻尾に対して意見が強すぎるか、
  もう 1 つの DAG 言語にならないと出荷できないほど一般的すぎる。
- **プロダクトの自由度。** kernel の上の product は「cron job」「single-step
  build」「multi-step pipeline」「post-activate notification」などを、ユーザー
  が必要とする粒度で正確にモデル化できる。すべてを 1 つの kernel 所有抽象に
  通すと、kernel が workflow scheduler になってしまう。
- **循環依存リスク。** workflow 機能は「deploy + hook 実行 + observe + 再
  deploy」 として表現されがちである。このループを kernel primitive
  にエンコードすると lifecycle が deploy bind され、`OperationPlan`
  の順序を独立に考えることが できなくなる。

## 2. workflow は `takosumi-git` に住む

workflow の関心事は完全に kernel の外にあり、姉妹 product である
**`takosumi-git`** が実装する。

1. git (push / PR / tag) を watch するか webhook イベントを受ける。
2. build pipeline を実行する (image build、artifact upload)。
3. resolved artifact URI を含む `Manifest` を生成する。
4. `POST /v1/deployments` で kernel に manifest を submit する。
5. manifest version 履歴を管理する — manifest file の git 履歴が authoritative
   な version 履歴。kernel は並列の "manifest version" 概念を保持しない。

`takosumi-git` が使うプロジェクトローカルなファイル (workflow 定義、
`.takosumi/` ディレクトリ構成、`manifest.yml` 等) はプロジェクトリポジトリに
住み、`takosumi-git` が解析する。kernel は決して触れない。kernel CLI もこれら の
path を auto-discover しない。`takosumi deploy` は明示的な manifest path を
取り、本体を `POST /v1/deployments` に POST する。kernel のリポジトリレベルの
入力は、HTTP で submit された `Manifest` body と、audit 用に caller が任意で
供給する不透明 provenance だけである。

したがって kernel は git を解釈せず、何もスケジュールせず、workflow step を
実行せず、workflow state を保持しない。caller の不透明 provenance JSON を WAL
entry に永続化して、operator が artifact から upstream workflow run へ遡れる
ようにすることはできる。それで kernel が workflow を所有することにはならない。

## 3. Git 切り離しの invariant

kernel は `takosumi-git` (あるいは他のクライアント) がどう駆動しようとも、 git
に依らない invariant を保つ。

- kernel データモデルには first-class な `commit` / `branch` / `ref` / `repo`
  field が無い。そのような値は upstream client が供給する不透明な deploy
  provenance の中にだけ現れる。
- `external-event` payload は kernel public API ではなく、`takosumi-git` の
  ような upstream product が受ける。これらの product が webhook 署名を検証し、
  manifest リクエストに不透明 provenance を attach しうる。
- kernel は不透明な deploy provenance を永続化しうるが、external-event
  エンドポイントを公開せず、event 署名検証を `POST /v1/deployments` の一部に
  しない。
- `source-archive` DataAsset kind は引き続き git に依らない。optional な
  `metadata.gitCommit` field は audit annotation のみで、kernel の判断には
  流れない。

## 4. kernel-known な workflow shape は無い

kernel-aware な workflow shape (例: `resource-workflow-v1`) は **提供しない**。
current v1 では provider-local な workflow / cron / hook shape を通常の
`resources[]` として定義することもしない。ベンダー workflow サービス (Cloudflare
Workflows、Temporal、Argo 等) を運用したい operator は、それを kernel 上の
product として provisioning するか、その backing compute / storage を通常の
resource shape で deploy し、trigger semantics を kernel の外に保つ。
これにより:

- curation 中立性 — curated 5-shape catalog は PaaS primitive に集中し続ける。
- image-first 一貫性 — `build` / `pipeline` 語彙が kernel-known shape に漏れ
  ない。
- プロダクト自由度 — 各 workflow product が trigger / run semantics を kernel
  manifest 語彙にせずに選べる。

## 5. 検討して却下した構造的代替案

- **workflow を組み込み shape として埋め込む。** curation 中立性と kernel の
  薄さを保つために却下 (§1)。
- **kernel workflow primitive を追加する。** kernel に 2 つ目の scheduler を
  モデル化させるため却下。代わりに `takosumi-git` が product 層で所有する。
- **workflow 用の別 manifest kind を導入する。** 却下。`takosumi-git` は通常の
  `kind: Manifest` ドキュメントを生成する。envelope 分割は不要。
- **manifest spec 内に workflow ファイル参照を許す。** kernel が workflow
  ファイルパスとビルド artifact を知ってしまうため却下。`takosumi-git` が
  manifest submit 前に artifact URI を解決する。

## 6. 境界

```text
inside Takosumi kernel       Manifest envelope (apiVersion / kind / metadata / resources)
                             Opaque deploy provenance persistence
                             Resource DAG resolution and apply
                             WAL idempotency, rollback, observation
                             Curated 5-shape catalog
                             Provider plugin host
                             HMAC-SHA256 enforcement on external events (if any)

inside takosumi-git          Git push / PR / tag watching
                             Webhook receivers
                             Workflow / build / pipeline execution
                             Artifact build and URI resolution
                             Manifest generation from workflow output
                             POST /v1/deployments client
                             Manifest version history (git-backed)
                             Project-local files under .takosumi/

outside both                 UI for workflow authoring (downstream tools)
                             Operator dashboards / audit consumers
                             Cross-product orchestration
```

## 関連 reference ドキュメント

- [Manifest Model](./manifest-model.md)
- [Operation Plan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
- [Data Asset Model](./data-asset-model.md)
- [Templates](/reference/templates)
