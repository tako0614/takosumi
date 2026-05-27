# アクセスモード {#access-modes}

access mode は 公式カタログの語彙です。component output や platform service
entry を consuming component
へ渡すとき、どの強さの権限で出力データを注入するかを表します。

manifest author は `connect.output`、`listen.path`、または `listen.kind`
で source を選び、`inject` で注入モードを選びます。resolved access mode は operator
policy、output slot または platform service entry / publication の
`safeDefaultAccess`、selected component kind の slot policy から決まり、
Deployment の記録に残されます。

```text
read | read-write | admin | invoke-only | observe-only
```

enum は閉じています。新規モード追加には `CONVENTIONS.md` §6 の RFC が必須で、
backend connector が単独で拡張することはできません。

## モードごとの意味

### `read`

解決された resource に対する観測のみのアクセス。 consumer は state (object
payload、 table rows、 queue depth、 configuration) の参照、 materialized
snapshot の購読、 schema の確認ができます。 **認証に必要な最小限以上の
credential material は生成されず**、 mutation API は射影されません。

- 許可: select / get / list / describe / subscribe
- 不許可: resource を変更する全ての呼び出し
- 典型例: `worker` component が同じ Installation 内の `postgres` output slot を
  `connect` で参照し、status view を構築する

### `read-write`

`read` に加えて、解決された resource の primary state surface に対する mutation
権限を持ちます。consumer は component kind schema または platform service entry
が示す mutation surface を介して、観測と更新の両方ができます。

- 許可: `read` の全権限に加え、 insert / update / upsert / delete
- 不許可: resource の lifecycle 管理 (recreate / drop / re-shard / root
  credential rotation / container 自体の削除)
- 典型例: backend `worker` が自身の `postgres` component に書き込む、 worker
  component が `object-store` component へ push する

### `admin`

解決された resource を完全に管理する権限です。 mutation に加えて lifecycle
operation (credential rotation、 recreate、 re-shard、 drop) を provider
境界の許す範囲で実行できます。閉じた enum
の中でもっとも特権的な値として扱います。

- 許可: `read-write` の全権限に加え、 component kind schema または selected
  binding が提供する管理操作
- 不許可: selected resource の管理範囲内では特になし。ただし他 resource
  への波及は operator policy / approval model 経由
- 既定では `admin` にはなりません。admin を含む access mode は operator policy /
  approval が resolution 時に明示選択する必要があり、 `safeDefaultAccess`
  からは導出されません
- 典型例: database を管理する operator 向け control plane Space (application
  Space では稀)

### `invoke-only`

consumer は component kind schema または platform service entry の invocation
surface を経由して resource を呼び出せますが、 state の直接 read / mutation
はできません。状態の確認は invocation result envelope を介してのみ可能です。

- 許可: component kind の invocation contract に基づく invoke / call / publish /
  submit
- 不許可: 蓄積された state の read、内部 queue の観測、 invocation envelope
  外での mutation
- 典型例: `worker` が他 component の invocation output を backend-native private
  routing や resolved material 経由で呼ぶ、 queue 自体の read 権限を持たず
  producer として submit のみ行う。public ingress への hairpin を前提にしない

### `observe-only`

consumer は output slot や platform service entry が emit する notification /
metrics / projection event を受け取れますが、 resource
自体には一切アクセスできません。同期 read も invocation も mutation
もありません。

- 許可: component kind の observation surface 経由の metric / event /
  notification 消費
- 不許可: resource への直接的な操作すべて
- 典型例: 多数の output stream を購読する metrics aggregator、 SIEM consumer

## `safeDefaultAccess`

output slot や platform service entry は `safeDefaultAccess`
を宣言できます。これは consuming connection 解決の既定値で、閉じた access mode
enum のうち safe default subset だけを選べます。

contract:

- `safeDefaultAccess` は `null` / `read` / `invoke-only` / `observe-only`
  のいずれか
- resource を変更する mode や管理者 mode は default にできない
- output slot や platform service entry が `safeDefaultAccess: null`
  の場合、operator policy は consuming connection に使う access mode
  を明示的に選ばなければならない。選べない場合は `access-required`
  で解決に失敗する
- 解決後の access mode は、operator policy 由来か default 由来かにかかわらず
  Deployment の記録に残される

## operator policy で access 選択が必須となる条件 {#link-access}

- output slot や platform service entry の `safeDefaultAccess` が `null` のとき
- connection が output を注入し、consuming component kind spec が当該 slot に
  explicit access detail を要求しているとき
- operator の policy pack が暗黙アクセスを禁止する component kind のとき
  (`prod/strict` と `enterprise/descriptor-approved-only` で有効)

operator policy が選んだ access mode を component kind の slot が unsupported
と宣言する場合、resolution はリソースの作成・更新前に reject されます。

## 承認 (approval) 無効化との関係 {#approval-invalidation}

resolved access mode の変更は、approval workflow を使う operator distribution
では approval-relevant です。典型的な approval-relevant change は次の通りです。

- consuming connection の resolved access mode が別モードに切り替わった
- output slot や platform service entry の `safeDefaultAccess`
  が変わり、consuming connection が default に依存していた
- output slot や platform service entry が operator policy review を必要とする
  stronger mode を要求するようになった

具体的な approval record、invalidation event、snapshot model は operator/account
layer の設計に属します。access mode spec は、`read-write` と `admin` が operator
policy / approval による明示選択を必要とする、という互換意味を定義します。

## 関連ページ {#related-pages}

- [Takosumi 公式カタログ仕様](./catalog.md)
- [プラットフォームサービス](./platform-services.md)
- [manifest](./manifest.md)
