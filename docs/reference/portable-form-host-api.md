# Portable Form host API

Takosumi は Takoform の host 境界を provider-neutral に実装しています。Takoform が Takosumi の
runtime 依存になることはありません。neutral API は `/v1/resources` と同じ canonical
`Resource`、`ResolutionLock`、`Run`、state、output、Activity audit レコードの上にある薄い
HTTP projection です。別のライフサイクルや冪等性台帳は作りません。

## Discovery と versioning

`GET /.well-known/takoform` は `forms.takoform.com/v1alpha1` と次の endpoint を
返します。

- `endpoints.api`: `/apis/forms.takoform.com/v1alpha1` — exact FormRef API
- `endpoints.forms`: principal-scoped な exact Form 一覧
- `endpoints.capabilities`: 既存の `/v1/capabilities` 互換 endpoint
- `endpoints.compatibility_api`: 既存の `/v1` 候補 API

現在の `terraform-provider-takoform` 候補は、設定した origin の `/v1/capabilities` と
`/v1/resources` を使います。これらの route は引き続き利用できますが、provider は互換クライアント
のままです。exact FormRef、ETag precondition、冪等性キーはまだ送信しません。portable-host
conformance として認められるには、将来の provider release が `endpoints.api` と versioned
contract を読み込む必要があります。

## Exact routes

versioned base は `/apis/forms.takoform.com/v1alpha1` です。

- `GET /forms` — principal-scoped な `FormAvailability` の一覧
- `POST /resources/preview` — 1 つの exact desired Resource のプレビュー
- `PUT /resources/{kind}/{name}` — 作成または更新
- `POST /resources/{kind}/{name}/import` — native identity のインポート
- `GET /resources/{kind}/{name}` — 読み取り
- `POST /resources/{kind}/{name}/observe` — drift の観測
- `POST /resources/{kind}/{name}/refresh` — canonical state の再公開
- `DELETE /resources/{kind}/{name}` — 削除

すべてのリクエストは完全な `InstalledFormReference` (API version、kind、definition version、
schema digest、package digest) を含みます。query ベースの読み取りでも 5 つの identity field が
すべて必要です。部分的または代替された identity を「latest」として解決することはありません。
新しい preview/apply/import 呼び出しでは、exact Form がインストール済み・実行可能・activate 済み・
acting principal に利用可能であることが追加で必要です。

## 並行性、リプレイ、エラー

作成は `If-None-Match: *` を使います。更新とライフサイクル操作は `If-Match` で quoted
Resource generation を渡します。変更操作には `Idempotency-Key` が必要です。キーは canonical
operation identity に組み込まれます。HTTP 側のリプレイ用データベースはありません。exact な
apply/import のリトライは、完了済みの canonical Resource を返します。存在しない exact Resource
の delete は成功します。stale または異なる desired state は `resource_version_conflict` を
返します。

レスポンスは安定した provider 向けエラーエンベロープを返し、Target、implementation、manager、
credential、capacity、price、SKU、quota、SLA の状態は含みません。canonical Output の生値も
省略します。generic host はどの値が安全な portable output field かを証明できないためです。
監査済みの runtime 値は、Form の `Interface` contract を通じて公開されます。

## Interface declaration の read (optional)

Form が宣言した runtime interface は、portable な read surface からも引けます
([ADR 0002](../../../docs/platform/decisions/0002-portable-interface-declarations.md))。

- `GET {api}/interfaces` — この Space の宣言一覧
- `GET {api}/interfaces/{name}` — 宣言名で 1 件

この surface は **optional** です。host は discovery の
`features.interface_declarations` と同一 origin の `endpoints.interfaces` で広告し、
flag が無い host も完全に conforming です (必須 negotiation flag には入りません)。

返すのは宣言された identity (`name` / `version`)、非 secret の document、解決済みの
public value だけで、id・generation・resolved revision・provenance・condition は
含みません。**この read は「何が存在するか」だけを答え、「誰が使ってよいか」は答えません**。
consumer 認可は `InterfaceBinding` による host 側の明示決定であり、portable な write
path はありません。宣言の作成・更新・retire は host 自身の fenced identity
(Takosumi では Capsule-scoped run credential) を通ります。

## Conformance runner

`bun run service-form:host-conformance` は、host に対して次のテストを実行します。
discovery、exact availability、retained negative desired-fixture rejection、
preview/apply/replay/read、canonical `/v1` Resource parity、digest-substitution rejection、
observe、refresh、canonical audit parity、optional import replay、冪等な delete です。

runner は exact identity、desired spec、optional `StandardFormNegativeFixture[]` の JSON
ファイルを受け取ります。bearer と native import identity は指定の環境変数からのみ読み込みます。
対応していない negative fixture stage は安全側に停止します。出力される proof は、実際に実行した
fixture だけの名前を含みます。実行後に未実行の名前を付け加えることはできません。digest-bound
report には各 positive/negative fixture の canonical input digest と exact portable
HTTP status/error code も含まれるため、成功した proof を別の fixture bytes に付け替えることは
できません。

runner が出力する digest-bound report は、standard Form admission evidence の host 側として
利用できます。provider conformance は別の evidence です。
