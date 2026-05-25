# アクセスモード {#access-modes}

Access modes are official catalog vocabulary. Takosumi core records the resolved
values in retained implementation/operator evidence associated with the
Deployment, and operator distributions enforce the policy that chooses them.

access mode は grant を発行する publication と、 consuming Space に publication
を射影する internal link resolution の権限 metadata です。AppSpec author は
`listen.from` で material source を選び、`listen.as` で projection family を選
びます。resolved access mode は operator policy、publication declaration の
`safeDefaultAccess`、selected component kind の slot policy から決まり、
Deployment に紐づく retained evidence に記録されます。

```text
read | read-write | admin | invoke-only | observe-only
```

enum は閉じています。新規モード追加には `CONVENTIONS.md` §6 の RFC が必須で、
provider / connector が単独で拡張することはできません。

## モードごとの意味

### `read`

publication の resource に対する観測のみのアクセス。 consumer は state (object
payload、 table rows、 queue depth、 configuration) の参照、 materialized
snapshot の購読、 schema の確認ができます。 **認証に必要な最小限以上の grant
material は生成されず**、 mutation API は射影されません。

- 許可: select / get / list / describe / subscribe
- 不許可: resource を変更する全ての呼び出し
- 典型例: `worker` component が同じ Installation graph 内の `postgres`
  publication を `read` link で参照し、status view を構築する

### `read-write`

`read` に加えて、 publication の primary state surface に対する mutation
権限を持ち ます。 consumer は component kind descriptor または publication
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

- 許可: `read-write` の全権限に加え、 component kind descriptor または selected
  implementation binding が提供する管理操作
- 不許可: resource scope 内では特になし。ただし他 resource への波及 (この
  publication が発行した link の revoke など) は kernel の grant model 経由
- 既定では `admin` にはなりません。admin を含む access mode は operator policy /
  approval が resolution 時に明示選択する必要があり、 `safeDefaultAccess`
  からは導出されません
- 典型例: database を管理する operator 向け control plane Space (application
  Space では稀)

### `invoke-only`

consumer は component kind descriptor または publication declaration の
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
を受 け取れますが、 resource 自体には一切アクセスできません。同期 read も
invocation も mutation もありません。

- 許可: component kind の observation surface 経由の metric / event /
  notification 消費
- 不許可: resource への直接的な操作すべて
- 典型例: 多数の publication の emission stream を購読する metrics aggregator、
  SIEM consumer

## `safeDefaultAccess`

publication declaration は `safeDefaultAccess` を宣言できます。これは consuming
link 解決の既定値で、閉じた access mode enum のうち safe default subset だけを
選べます。

contract:

- `safeDefaultAccess` は `null` / `read` / `invoke-only` / `observe-only` のい
  ずれか。 `read-write` と `admin` は default にできない
- grant 発行 publication で `safeDefaultAccess: null` の場合、operator policy は
  consuming link に使う access mode を明示的に選ばなければならない。選べない場合
  は `access-required` で解決に失敗する
- 解決後の access mode は、operator policy 由来か default 由来かにかかわらず
  Deployment に紐づく retained link projection evidence に記録される

## operator policy で access 選択が必須となる条件 {#link-access}

- publication の `safeDefaultAccess` が `null` のとき
- link が grant 発行 publication を射影し、 consuming component kind spec が当該
  slot に grant detail を要求しているとき
- operator の policy pack が暗黙アクセスを禁止する component kind のとき
  (`prod/strict` と `enterprise/descriptor-approved-only` で有効)

operator policy が選んだ access mode を component kind の slot が unsupported
と宣言する場合、resolution は provider side effect 前に reject されます。

## 承認 (approval) 無効化との関係 {#approval-invalidation}

resolved access mode changes are approval-relevant for operator distributions
that use approval workflows. Typical approval-relevant changes are:

- consuming link の resolved access mode が別モードに切り替わった
- publication の `safeDefaultAccess` が変わり、 consuming link が default
  に依存していた
- grant 発行 publication が operator policy review を必要とする stronger mode
  を要求するようになった

具体的な approval record、invalidation event、snapshot model は
operator/account-plane または reference implementation の設計に属します。access
mode spec は、`read-write` と `admin` が operator policy / approval による明示
選択を必要とする、という互換意味を定義します。

## 関連アーキテクチャ {#related-architecture-notes}

- `docs/reference/architecture/kind-resolution-model.md` — access mode enum
  を閉じる根拠と、resolved access mode / safe default subset の関係
- `docs/reference/architecture/link-projection-model.md` — link projection が
  resolved access mode を記録する経路と effect-detail への影響
- `docs/reference/architecture/external-publication-model.md` — grant 発行
  default が `admin` を取れない理由と publication 側 enforcement

## 関連ページ {#related-pages}

- [Enum and Value Index](./closed-enums.md)
- [Takosumi Official Type Catalog Specification](./type-catalog.md)
- [Provider Implementations](./providers.md)
