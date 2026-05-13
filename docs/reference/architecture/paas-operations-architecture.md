# PaaS Operations Architecture

> このページでわかること: PaaS 運用アーキテクチャの全体像。

本ドキュメントは、Takosumi を PaaS として運用するときに公開する v1 operations
primitive — quota tier、cost attribution、SLA breach detection、zone 選択、
incident model、support impersonation、notification emission — のアーキテクチャ
上の根拠を記録する。wire-level の shape は reference 層に置き、本ドキュメント
は「なぜ各 surface が kernel 側にあるか」と「境界はどこで止まるか」を説明する。

## Quota tier: operator が命名、kernel が cap を強制

quota tier は dimension cap の名前付きバンドルである。kernel は `free`、`pro`、
`enterprise` 等を default として **同梱しない**。理由は次の通り。

- **tier 名は pricing 成果物である。** 各 PaaS distribution は独自の price book
  と契約 surface を持つ。kernel が tier 名を hard-code すれば、operator は外来
  語彙を受け入れるか、文字列を変えるために kernel を fork するかになる。どちら
  も許容できない。
- **cap の強制は依然 kernel が行う。** operator は内部 control plane で tier を
  登録する。Space は厳密に 1 つの `quotaTierId` を持つ。kernel は quota
  dimension を評価するとき Space の tier を解決し、quota 強制で既に使われている
  「new work は fail-closed、in-flight は fail-open」 のルールを適用する。
- **v1 では tier は flat である。** 継承なし、親 tier なし、合成なし。各 Space
  はちょうど 1 つの tier に解決される。合成すると kernel がリクエスト時に
  derived cap を計算する必要が生じ、audit trail も薄まる。階層化したい operator
  は pricing system 側で合成し、結果として得られる flat tier を登録する。
- **登録 tier がゼロの installation は boot 時に fail-closed する。** これは
  意図的: tier system のない PaaS には強制可能な per-Space 上限がない。kernel は
  そのモードで Space provisioning を拒否する。

結果として、kernel が機械的に所有し、operator が意味的に所有する tier 抽象が
得られる。

## Cost attribution は opaque メタデータ

各 Space は optional な `attribution` map (`costCenter`、`projectCode`、
`customerSegment`、`customLabels`) を持つ。kernel は値を導出せず、語彙を
validate せず、case を正規化もしない。理由:

- **cost 語彙は operator 私用である。** `costCenter` 文字列は kernel が決して
  見ない外部の総勘定元帳システムに対応する。kernel が値を format-check すれば、
  正当な operator code を reject するか、無効な値を誤って受け入れることになる。
- **PII リスクは operator 管理である。** `customerSegment` 値はマーケティング
  ラベル、コンプライアンスクラス、契約コードかもしれない。kernel にはわからな
  い。すべての値を opaque に扱うことで、kernel は signal のない判断から離れる。
- **テレメトリラベルと audit envelope は map をそのまま運ぶ。** 外部 cost
  pipeline は attribution key でラベル付けされた kernel 発行 metric と、同じ map
  を含む audit event を集約する。kernel は join key を公開し、operator が join
  を組む。

per-key 値 cap (length、文字クラス、map 合計サイズ) は **強制される**。これら は
storage / telemetry のための正しさ cap であり、語彙 cap ではない。

## SLA breach detection: 計測は kernel、credit 計算は operator

SLA breach detection は kernel 側、サービス credit 計算はそうではない。理由:

- **二重簿記は audit 整合性を壊す。** kernel が raw metric だけを出し外部
  システムが breach を計算すると、2 つのシステムが window / threshold / breach
  状態を追跡する。両者は drift する。breach が起きたかどうかで顧客と operator
  が食い違う。
- **breach detection は audit chain に参加する。** 各 breach 遷移は audit event
  である。chain に結びつけることで、credit の disputed はすべて chain replay で
  決着でき、parallel log の reconcile では決まらない。
- **credit 公式は契約固有である。** 「p99 breach が 5 分続いたら顧客に 10%
  credit」 は契約条項であり、kernel invariant ではない。kernel は breach signal
  を発行 し、operator の billing pipeline が独自公式で credit を計算する。
- **dimension は closed。** v1 dimension 集合は固定 (apply latency percentile、
  activation latency、WAL stage 期間、drift detection 遅延、RevokeDebt aging、
  readiness 比、throttle 比、エラー率)。dimension を追加すると operator の SLO
  コミットメントが変わるため、`CONVENTIONS.md` §6 を経る。

閾値は operator が供給する。window 長は範囲内で operator が tune できる。検知
ロジックと audit 遷移は kernel 固定である。

## Zone 選択: v1 では single-region

zone は Space / Object / DataAsset / Connector scope に付く operator 定義の
文字列である。kernel は manifest 展開、drift detection、audit を通じてこれを
伝播する。topology graph や latency table を所有しない。制約:

- **v1 installation のすべての zone は 1 region にある。** region 跨ぎの書込み、
  region failover、geo-routing は scope 外。複数 region が必要な operator は
  将来の multi-region account-plane / operator RFC を使うこと。region ごとに
  Takosumi installation を 1 つずつ動かしてもプラットフォーム federation には
  ならない。
- **zone 文字列は opaque。** 似た名前の 2 つの zone は無関係である。kernel は
  文字列形から隣接性を推論しない。affinity rule (「この object を あの DataAsset
  と同じ zone に置く」) は等値比較なので表現できる。latency-aware placement は
  topology を要するため表現できない。
- **zone-agnostic モードがある。** `TAKOSUMI_ZONES_AVAILABLE` が未設定なら
  すべての zone field は評価時に無視される。小規模 installation は zone 語彙
  を宣言するコストを払わずに済む。

region 跨ぎ semantics が来るときは
[PaaS Provider Architecture](./paas-provider-architecture.md) の single-region
invariant を変えるため、`CONVENTIONS.md` §6 RFC を通す。

## Incident model: 検知も state も kernel、narrative は operator

Incident は kernel に記録される service-impacting event である。Origin は自動
検知 (SLA breach、RevokeDebt が `operator-action-required` まで aging、
readiness probe 失敗、内部エラー率の持続) または operator 宣言のいずれかである。
理由:

- **自動検知は signal が存在する場所にある。** SLA breach 評価、RevokeDebt
  aging、readiness probe はすでに kernel 側。これらの signal から incident を
  起こすことで二重 polling 層を避ける。
- **state machine は audit chain に結びつく。** 各遷移は audit event。事後
  分析の証拠は chain replay であり、log から復元したタイムラインではない。
  kernel 側 SLA 検知と同じ性質。
- **operator 宣言 incident も同じ record 形を共有する。** 自動検知されなかった
  障害を顧客が報告した場合、operator は内部 control plane で incident を宣言
  する。同じ state machine をたどり、同じ audit envelope を生成する。Origin が
  記録されるので incident review を検知ソースで slice できる。
- **顧客向け表示は operator surface。** ステータスページ、incident
  タイムライン、 顧客メール、Slack 描画は kernel の関心事ではない。kernel
  は構造化 record と audit 遷移を発行し、operator がどう surface するかを選ぶ。

## Support impersonation: 別の auth path

顧客 Space を見る必要のあるサポート担当者は別の auth path を通る。

- **`support-staff` は独立した Actor 型である。** support-staff Actor は
  Membership 経由で Space role を持たない。operator 管理で operator の support
  tenant に住む。
- **権限は role でなく grant から来る。** support-staff Actor は
  `SupportImpersonationGrant` で特定 Space への `read-only` または `read-write`
  アクセスを得る。read-write grant は顧客 admin の明示承認を要する。両 grant
  種別とも時間制限付き。
- **すべての session が audit grade。** session open、impersonation 下のすべての
  kernel operation、session close は、support actor id、grant id、ticket
  reference、承認した顧客 admin を attach する。tenant 跨ぎアクセスは replay
  可能。
- **bootstrap surface は operator only。** public deploy bearer token や
  runtime-agent enrollment は `support-staff` Actor を mint できない。発行 path
  は内部 control plane のみで HMAC で gate される。

このアーキテクチャは Space containment invariant に違反せず operator が顧客を
サポートできるようにする。kernel はアクセスが scoped・時間制限付き・承認済み
であったことを証明する。中に入った support staff が正しく振る舞ったかは証明
しない (これは operator policy の関心事)。

## Notification emission: pull only、kernel は配信しない

kernel は notification signal を記録するが配信しない。operator が signal queue
を consume し、email / Slack / SMS / in-app / digest channel に fan out する。
理由:

- **kernel は配信 credential を保持しない。** SMTP server、Slack workspace
  token、SMS gateway key、webhook secret は operator の成果物。kernel に置けば、
  検証する必要のない credential まで kernel の blast radius を広げる。
- **pull only は既存の webhook 決定と整合する。** Takosumi は意図的に外部
  listener に push しない (v1 webhook scope 決定について
  [PaaS Provider Architecture](./paas-provider-architecture.md) を参照)。
  notification は同じ境界に従う: kernel は signal を発行し、operator 管理の 配信
  worker が queue を読む。
- **顧客可視の notification はすべて audit event を持つ。** signal stream は
  audit event の精選 subset に少数の derived event (`approval-near-expiry` 等)
  を加えたもの。operator の外側のスタックは kernel が先に signal として発行
  していない顧客可視 notification を mint できない。
- **idempotency は kernel 側。** 重複 signal の抑制は発行ルールの一部であり、
  retry された apply や ばたつく breach が notification の洪水を mint しない
  ようになっている。operator は de-duplicate された stream を pull する。

受信者解決は kernel 側: kernel は role と Membership に基づいて signal を
受けるべき Actor を解決する。配信 channel 選択 (email vs. Slack vs. なし) は
operator 側。

## 境界

kernel が同梱するもの:

- quota tier 登録 API と per-Space tier binding。
- 不透明な attribution map と audit / telemetry を通じた伝播。
- closed な SLA dimension 集合と breach detection の state machine。
- single-region な zone 属性と manifest 展開を通じた伝播。
- Incident record、その state machine、自動検知 trigger、audit 遷移。
- support impersonation の grant / session record と audit grade な scoping
  ルール。
- notification signal record、closed category enum、受信者解決、pull queue。

kernel が同梱しないもの:

- 公開ステータスページ UI、顧客ダッシュボード、SRE 向け内部ツール。
- チケットシステム、画面共有ツール、サポート側の incident editor。
- SLA credit calculator、契約固有の credit 公式、invoice surface。
- メールテンプレート、Slack bot、SMS レンダリング、in-app バナーコンポーネント。
- incident / notification の顧客側 acknowledge / mute UI。

## 関連 reference ドキュメント

- [Quota Tiers](../quota-tiers.md)
- [Quota and Rate Limit](../quota-rate-limit.md)
- [Cost Attribution](../cost-attribution.md)
- [SLA Breach Detection](../sla-breach-detection.md)
- [Zone Selection](../zone-selection.md)
- [Incident Model](../incident-model.md)
- [Support Impersonation](../support-impersonation.md)
- [Notification Emission](../notification-emission.md)
- [Audit Events](../audit-events.md)
- [Telemetry / Metrics](../telemetry-metrics.md)

## クロスリファレンス

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
- [Identity and Access Architecture](./identity-and-access-architecture.md)
- [Tenant Lifecycle Architecture](./tenant-lifecycle-architecture.md)
- [Operational Hardening Checklist](./operational-hardening-checklist.md)
