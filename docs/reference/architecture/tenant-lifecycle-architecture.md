# Tenant Lifecycle Architecture

> このページでわかること: tenant lifecycle の設計とステート管理。

本ドキュメントは、v1 の tenant lifecycle のアーキテクチャ根拠を記録する: Space
の provisioning、trial Space と paid Space の違い、顧客データの export、Space の
deletion。wire-level の shape (request body、status field、audit event payload)
は reference 層にある。本ドキュメントは kernel が保つ invariant と、 意図的に
operator に委ねる surface を説明する。

## Tenant 単位の invariant

v1 の tenant 単位は `Space` である。顧客は 1 つの Organization の中の 1 つの
Space である。理由:

- **`Space` はすでに kernel の isolation primitive である。** namespace、
  secret、journal、observation、approval、activation はすべて Space scope で
  ある ([Space Model](./space-model.md))。`Space` の上に並列の "tenant" 概念を
  追加すると、kernel が揃え続けねばならない境界が 2 つになる。
- **より大きな "tenant" は許可するが operator 定義である。** 顧客が 1 つの
  Organization 下に `prod` / `staging` / `dev` を別 Space として運用するのは
  完全に表現可能。kernel は per-Space invariant のみを強制する。顧客形のグルー
  プ化は Organization と operator policy の性質であって kernel state ではない。
- **`1 Space = N tenants` は却下。** 1 つの Space の中に 2
  つの契約境界を持つと、 kernel は apply 時に per-Space state
  を分割する必要が生じる。kernel はその 分割を見ない。invariant は「1 Space = 1
  tenant」で止まる。

したがって、「tenant lifecycle」は `Space` lifecycle を意味する。

## provisioning が closed な 7 段 sequence である理由

tenant provisioning は順序付き 7 ステージに分解され、各ステージは idempotent で
journal される。

```text
1. namespace-partition-allocate
2. secret-partition-init
3. quota-tier-apply
4. catalog-release-adopt
5. default-operator-account
6. audit-chain-genesis
7. observation-set-init
```

アーキテクチャ根拠:

- **各ステージは既存の 1 つの kernel substrate を対象とする。** Step 1 は
  storage schema、Step 2 は secret partition、Step 3 は quota dimension table、
  Step 4 は catalog adoption、…。provisioning はすべての Space scope substrate
  を 1 回ずつ歩く fan-in 点である。これにより、既存 Space scope state と並列に
  存在する新規 "tenant table" を発明せずに済む。
- **idempotent + journal は recovery を無料にする。** retry は未完了の最初の
  ステージから再開する。ステージ間の電源断は半端な Space を作らず、次の呼び出し
  が journal の完了 record を読んで続行する。
- **partial failure は自動 cleanup されない。** ステージが永続失敗した場合、
  kernel は完了済みステージを逆順で rollback する。rollback 自身が失敗したら、
  Space は黙って破壊されるのではなく `operator-action-required` で保持される。
  kernel は「半端な Space を放置する方が安全」とは仮定しない。partial
  provisioning でも顧客データ (audit chain genesis、secret partition) を保持
  しうるからである。
- **`Idempotency-Key` は必須。** これは client 側 retry が同じ intent 下で別の
  id で 2 番目の Space を mint することを防ぐ。

この分解は v1 で closed である。新規ステージを追加するには `CONVENTIONS.md` §6
RFC を要する。ステージを追加すると、operator が既に考慮している failure surface
が変わるためである。

## trial Space が別 lifecycle である理由

trial Space は「単に低い quota tier を持つ Space」ではない。別の lifecycle state
machine を使う: `active-trial`、`expiring-soon`、`frozen`、`cleaned-up`、
`converted`。理由:

- **商用 PaaS は incident scoping のために trial を別扱いする。** operator は
  outage の triage で paid 顧客と trial 顧客のインパクトを切り分ける必要がある。
  両方を 1 つの lifecycle に通すと、paid 顧客の signal が trial ノイズで薄まる
  か、trial Space が paid 級のエスカレーション path に置かれる。
- **trial は構造上終了日を持つ。** trial Space では `trialExpiresAt` が必須。
  state machine は 4 つの観測可能な転帰 — まだアクティブ、期限接近、期限切れで
  読取専用 grace、cleanup 済み — を、operator が脇テーブルを発明せずに表現
  できる形でエンコードする。
- **conversion は audit 連続性を保つ。** trial から paid への conversion は
  新しい Space id を mint しない。audit chain、journal、observation set、
  namespace registry は同じ `space:<id>` に attached されたまま。trial 中に
  conversion する顧客はデータを失わず、migration 境界も生じない。
- **frozen grace は kernel 側の性質。** `trialExpiresAt` 後の 24 時間 read-only
  window は operator が kernel の上で実装するものではなく、Space 自身の state
  machine の一部。これにより、2 つの operator が「期限切れ」の意味で食い違わ
  ない。

`active-trial` と `converted` だけが顧客可視の長時間 state である。`frozen` と
`cleaned-up` は operator 可視の終端。operator 駆動の延長 path は明示的
(`POST /api/internal/v1/spaces/:id/trial/extend`) であり、「trial 延長」は
ad-hoc な field 書き込みではなく first-class アクションとなる。

## data export と deletion: アーキテクチャ制約

顧客は Space のデータを export し、Space を delete できる。kernel はこれらを
right-to-erasure 規制 (GDPR、地域同等品) に準拠させる primitive を公開する。
制約:

- **2-phase delete (soft → hard)。** soft-delete は範囲付き window 内で
  reversible、hard-delete は終端。顧客事故と operator 事故の両方が soft phase
  で復旧 path を持つ。hard-delete が完了したら Space は復旧できず、audit
  retention window が始まる。
- **redaction を通じて audit chain hash は保たれる。** hard-delete は audit
  chain を破壊しない。field-level の redaction が PII をゼロ化しつつ hash chain
  整合性を保つので、下流 verifier (compliance tool、legal review) は壊れていない
  chain を見続けられる。chain の断絶自身が調査を要する compliance signal で
  あり、redaction はその signal を出してはならない。
- **retention regime は kernel-aware。** Organization 上の `complianceRegime` が
  redacted audit chain の保持期間を決める。kernel は regime を選ばない。
  operator が Organization 作成時に選ぶ。kernel はセットされた regime が
  強制されることのみを保証する。
- **export は database dump ではなく論理フォーマット。** `data-portability`
  export は別の Takosumi installation が import できる schema バージョン付き
  バンドルを生成する。これが v1 のデータ可搬性 contract。将来の schema 破壊
  変更はバージョン付き export を通る。今日の export は将来も読める。
- **顧客セルフサービス削除は scope 内、admin エスカレーションは scope 外。**
  kernel は export / delete エンドポイントを公開する。顧客向け UI、legal-hold
  エスカレーション、サポート側の削除取消ワークフローは Takosumi の外。

## tenant data portability の根拠

論理 export フォーマットが存在するのは次のため:

- 顧客が 1 つの Takosumi installation を離れて別の installation に audit history
  を失わずに再加入できるように。
- operator が容量や compliance 上の理由で Space を kernel 間で移動できるように。
- 将来の major migration が、database レベルの翻訳を要しない安定入力形式を持つ
  ように。

export は backup の代替では **ない**。Backup は kernel 側の recovery 用で、
[Backup and Restore](../backup-restore.md) に従う。Export は顧客向け可搬性
surface で、operator backup policy から独立している。

## 境界

kernel が同梱するもの:

- 7 ステージ provisioning state machine と idempotency / rollback ルール。
- trial Space 属性集合と 5-state lifecycle (frozen grace、operator 駆動延長を
  含む)。
- soft-delete / hard-delete の 2-phase deletion API と、audit hash を保つ
  field-level redaction。
- 4 つの export モード (`full`、`manifest-only`、`audit-only`、
  `data-portability`) と、その schema バージョン付きフォーマット。

kernel が同梱しないもの:

- 顧客向けサインアップフォーム、決済フロー、TOS 同意 UI。
- 顧客向けアカウント削除 UI や 削除取消ワークフロー。
- admin エスカレーション path、legal-hold オーケストレーション、regime 選択
  ウィザード。
- メールテンプレート、in-app バナー、trial conversion マーケティング surface。

これらは kernel primitive の上に組み立てられるが operator の関心事である。

## 関連 reference ドキュメント

- [Tenant Provisioning](../tenant-provisioning.md)
- [Trial Spaces](../trial-spaces.md)
- [Tenant Export and Deletion](../tenant-export-deletion.md)
- [Compliance Retention](../compliance-retention.md)
- [Storage Schema](../storage-schema.md)
- [Backup and Restore](../backup-restore.md)

## クロスリファレンス

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
- [Identity and Access Architecture](./identity-and-access-architecture.md)
- [PaaS Operations Architecture](./paas-operations-architecture.md)
