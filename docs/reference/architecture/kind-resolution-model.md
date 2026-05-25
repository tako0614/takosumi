# Kind Resolution モデル {#kind-resolution-model}

public manifest は `components.<name>.kind` と kind-specific な open `spec` から runtime intent を表す。component kind の意味と input schema は operator が選ぶ kind の定義 / catalog metadata が表し、provider mapping と Space policy は operator の設定が定義する。Takosumi Kind Catalog の kind の定義は JSON-LD で公開される official catalog documents です。

## Public な component kind {#public-component-kind}

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

kind resolution は `components.<name>.kind` から始まる。値が absolute URI として parse できる場合、その URI が resolved kind URI です。それ以外の値は short alias として operator-provided alias map / profile で exact match 解決する。未解決 alias は provider side effect 前に fail-closed で拒否される。解決された operator-selected binding は deploy evidence として Deployment に紐づき、component kind の semantic identity とは別に記録される。

## External kind schema {#external-kind-descriptor}

external kind schema は operator / registry が必要に応じて採用する semantic data です。kind の定義は例えば次を定義できます。

```text
input schema
publication contracts
projection vocabulary
operation vocabulary
mutation constraints
compatibility hints
```

asset を扱う場合、operator extension の policy として扱います。

## Kind / provider resolution {#kind-provider-resolution}

resolution は operator-owned で、決定的かつ fail-closed にする。Takosumi は manifest を受け、Installation に紐づく Deployment として resolution evidence を記録する。

```text
1. Read `components.<name>.kind`.
2. If the value parses as an absolute URI, use it as the resolved kind URI.
3. Otherwise resolve it through the operator-provided alias map / profile;
   unresolved aliases fail before provider side effects.
4. If the operator uses kind definition metadata, select the definition for the
   resolved URI.
5. If kind definition input schema is present, validate `spec` against that schema.
6. Check that the operator has an execution binding visible to the Space and
   apply provider support metadata and Space policy checks.
7. Link the operator-selected implementation evidence to the Deployment as
   deploy record, and expose only component JSON outputs
   through public Deployment outputs.
```

`https://takosumi.com/kinds/v1/*` official catalog の kind の定義 may be one input to this process. Operators can adopt those documents or publish their own catalog.

## Component 入力スキーマ {#input-schema}

Component input 検証は `components.<name>` を `components.<name>.kind` で選ばれた component kind contract に対して validate する。provider のサポート metadata は provider resolution の段階でチェックされる。

```text
JSON-LD / kind の定義:
  identity and semantic relations

Input schema:
  component `spec` validation

Policy:
  allow / deny / approval

Binding:
  external consistency and smoke checks
```

## Mutation 制約 {#mutation-constraints}

mutation 動作は external component kind / provider contract が定義する。下記は official catalog の kind の定義で使える vocabulary の例です。

| mutation-constraint | semantics                                                            | allowed lifecycle classes    |
| ------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `immutable`         | object cannot change after create; replace required for any mutation | managed, generated           |
| `replace-only`      | every mutation creates a new object and revokes the previous one     | managed, generated           |
| `in-place`          | every mutation updates the same object identity                      | managed, generated, imported |
| `append-only`       | mutations may only add; existing fields cannot change or be removed  | managed, generated, imported |
| `ordered-replace`   | replaces are serialized; no concurrent replaces in one Space         | managed, generated           |
| `reroute-only`      | object identity is fixed; mutations only re-point traffic / handles  | external, operator, imported |

`external` と `operator` lifecycle class は external identity を参照するため、 `reroute-only` mutation を取る。

Mutation 制約は kind の定義のメタデータである。operator-selected implementation binding は planning / apply 中にその制約を enforce します。 runtime operation planning は [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal) に記録され、[Object Model — Revoke participation matrix](./object-model.md) に従います。JSON-LD の kind の定義は runtime operation mechanism ではありません。

## Access mode enum {#access-mode-enum}

resolved link access は official catalog の [Access modes](../access-modes.md) で定義された closed v1 モードのいずれかである。manifest v1 の `listen` には `access` property は無く、operator policy、publish の出力の declaration の `safeDefaultAccess`、selected component kind の slot policy から resolution 中に決まる。このページは access mode が resolution に参加する位置を説明する。 [バインディングモデル](./binding-model.md) と [Platform Service Model](./platform-service-model.md) は access mode vocabulary を再定義せずに [Access modes](../access-modes.md) を参照する。

```text
read         observation only; no authorization material is generated
read-write   read plus mutation rights on the publication's resource
admin        full management of the publication's resource
invoke-only  may call the resource but cannot read or mutate underlying state
observe-only may only receive notifications / metrics; no resource access
```

operator policy が明示的に access mode を選ぶ場合は、この閉じた集合から選ぶ。 publish の出力の declaration の `safeDefaultAccess` はそのうち `null | read | invoke-only | observe-only` だけを default にできる。 `read-write` と `admin` は default にできず、operator policy / approval が resolution 時に明示選択する。新規の access mode は RFC (CONVENTIONS.md §6) を要する。safe default の詳細は [Access Modes](../access-modes.md#safedefaultaccess) を参照。

## Space 固有の availability {#space-specific-availability}

kind alias や provider implementation が operator registry に存在しても、ある Space では利用不可能であることがある。resolution は alias / implementation binding と Space policy の許可の両方を要求する。
