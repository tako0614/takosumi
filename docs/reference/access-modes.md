# アクセスモード {#access-modes}

access mode は Kind カタログの語彙です。publish の出力を consuming component
へ渡すとき、どの強さの権限で出力データを注入するかを表します。

manifest author は `listen.from` で出力データの source を選び、`listen.as` で
注入モードを選びます。resolved access mode は operator policy、publish の出力
の宣言の `safeDefaultAccess`、selected component kind の slot policy から決まり、
Deployment の記録に残されます。

```text
read | read-write | admin | invoke-only | observe-only
```

enum は閉じています。新規モード追加には `CONVENTIONS.md` §6 の RFC が必須で、
provider / connector が単独で拡張することはできません。

## モードごとの意味

### `read`

publication の resource に対する観測のみのアクセス。 consumer は state (object
payload、 table rows、 queue depth、 configuration) の参照、 materialized
snapshot の購読、 schema の確認ができます。 **認証に必要な最小限以上の
credential material は生成されず**、 mutation API は射影されません。

- 許可: select / get / list / describe / subscribe
- 不許可: resource を変更する全ての呼び出し
- 典型例: `worker` component が同じ Installation 内の `postgres` の publish の
  出力を `read` link で参照し、status view を構築する

### `read-write`

`read` に加えて、 publication の primary state surface に対する mutation
権限を持ちます。consumer は component kind schema または publication
declaration が示す mutation surface を介して、観測と更新の両方ができます。

- 許可: `read` の全権限に加え、 insert / update / upsert / delete
- 不許可: resource の lifecycle 管理 (recreate / drop / re-shard / root
  credential rotation / container 自体の削除)
- 典型例: backend `worker` が自身の `postgres` component に書き込む、 worker
  component が `object-store` component へ push する

### `admin`

publication の resource を完全に管理する権限です。 mutation に加えて lifecycle
operation (credential rotation、 recreate、 re-shard、 drop) を provider 境界の
許す範囲で実行できます。閉じた enum の中でもっとも特権的な値として扱います。

- 許可: `read-write` の全権限に加え、 component kind schema または selected
  binding が提供する管理操作
- 不許可: selected publication material の管理範囲内では特になし。ただし他
  resource への波及 (この publication が発行した link の revoke など) は
  operator policy / approval model 経由
- 既定では `admin` にはなりません。admin を含む access mode は operator policy /
  approval が resolution 時に明示選択する必要があり、 `safeDefaultAccess`
  からは導出されません
- 典型例: database を管理する operator 向け control plane Space (application
  Space では稀)

### `invoke-only`

consumer は component kind schema または publication declaration の
invocation surface を経由して resource を呼び出せますが、 state の直接 read /
mutation は できません。状態の確認は invocation result envelope
を介してのみ可能です。

- 許可: component kind の invocation contract に基づく invoke / call / publish /
  submit
- 不許可: 蓄積された state の read、内部 queue の観測、 invocation envelope
  外での mutation
- 典型例: `worker` が他 component の invocation surface / publication を
  provider-native private routing や resolved material 経由で呼ぶ、 queue 自体の
  read 権限を持たず producer として publish のみ行う。public ingress への
  hairpin を前提にしない

### `observe-only`

consumer は publication が emit する notification / metrics / projection event
を受け取れますが、 resource 自体には一切アクセスできません。同期 read も
invocation も mutation もありません。

- 許可: component kind の observation surface 経由の metric / event /
  notification 消費
- 不許可: resource への直接的な操作すべて
- 典型例: 多数の publication の emission stream を購読する metrics aggregator、
  SIEM consumer

## `safeDefaultAccess`

publish の出力の宣言は `safeDefaultAccess` を宣言できます。これは consuming
link 解決の既定値で、閉じた access mode enum のうち safe default subset だけを
選べます。

contract:

- `safeDefaultAccess` は `null` / `read` / `invoke-only` / `observe-only` のい
  ずれか。 `read-write` と `admin` は default にできない
- publish の出力の宣言で `safeDefaultAccess: null` の場合、operator policy
  は consuming link に使う access mode を明示的に選ばなければならない。選べない
  場合は `access-required` で解決に失敗する
- 解決後の access mode は、operator policy 由来か default 由来かにかかわらず
  Deployment の記録に残される

## operator policy で access 選択が必須となる条件 {#link-access}

- publish の出力の `safeDefaultAccess` が `null` のとき
- link が publish の出力を注入し、consuming component kind spec が当該 slot に
  explicit access detail を要求しているとき
- operator の policy pack が暗黙アクセスを禁止する component kind のとき
  (`prod/strict` と `enterprise/descriptor-approved-only` で有効)

operator policy が選んだ access mode を component kind の slot が unsupported
と宣言する場合、resolution はリソースの作成・更新前に reject されます。

## 承認 (approval) 無効化との関係 {#approval-invalidation}

resolved access mode の変更は、approval workflow を使う operator profile
では approval-relevant です。典型的な approval-relevant change は次の通りです。

- consuming link の resolved access mode が別モードに切り替わった
- publish の出力の `safeDefaultAccess` が変わり、consuming link が default
  に依存していた
- publish の出力の宣言が operator policy review を必要とする stronger mode
  を要求するようになった

具体的な approval record、invalidation event、snapshot model は
operator/account layer の設計に属します。access mode spec は、`read-write` と
`admin` が operator policy / approval による明示選択を必要とする、という互換意
味を定義します。

## 関連ページ {#related-pages}

- [Takosumi Kind カタログ仕様](./type-catalog.md)
- [プラットフォームサービス](./external-publications.md)
- [manifest](./manifest.md)
