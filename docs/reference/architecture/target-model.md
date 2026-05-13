# Target Model

> このページでわかること: target モデルの設計と deploy 先の解決。

ObjectTarget は Object の surface と lifecycle 期待値を定義する。public な
フィールドに分解されることはない。

## Public resource target

```yaml
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/cloudflare-workers"
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
```

public v1 は別の top-level `target` field を公開しない。resource target は
`resources[].shape` と optional な `resources[].provider` hint から始まり、
current Space に許可された catalog / provider registry / policy に対して
解決される。解決された provider は Deployment の証拠であり、Shape の semantic
identity ではない。

## ObjectTarget descriptor

ObjectTarget descriptor は次を定義する。

```text
input schema
accepted data asset kinds
possible exports
projection capabilities
operation capabilities
mutation constraints
implementation requirements
```

## Concrete, abstract, and composite targets

```text
concrete target:
  a specific object surface such as cloudflare-workers or aws-s3

abstract target:
  a selector resolved by profile and policy, not by open-ended graph search

composite target:
  declarative expansion into objects, links, exports, and exposures
```

### Target selection algorithm

resolution は決定的で fail-closed な pipeline を使う。許可された candidate を 1
つだけ出した最初のステップが勝つ。0 個または 2 個以上の candidate を出した
ステップは resolution を失敗させる。

```text
1. Catalog alias lookup
   The public manifest value (e.g. `cloudflare-workers`) must resolve to
   exactly one descriptor in the CatalogRelease adopted by the current
   Space.

2. Concrete match in Space
   If the descriptor is concrete and the Space allows it, resolution
   succeeds with that descriptor.

3. Abstract fallback by profile
   If the descriptor is abstract, the profile order is consulted. The
   first concrete candidate that the Space policy allows wins.

4. Composite expansion
   If the descriptor is composite, it expands into a graph of objects,
   links, exports, and exposures. Each child enters this same pipeline at
   step 1.

5. Fail-closed
   If no step has produced a single allowed concrete descriptor,
   resolution fails. v1 has no graph search, no operator override at
   resolution time, and no catalog escape hatch.
```

## Input schema

Target input 検証は `resources[].spec` を `resources[].shape` で選ばれた Shape
contract に対して validate する。provider のサポートと capability 制約は
provider resolution の段階でチェックされる。

```text
JSON-LD / descriptor:
  identity and semantic relations

Input schema:
  shape validation for `spec`

Policy:
  allow / deny / approval

Implementation verify:
  external consistency and smoke checks
```

## Mutation constraints

target の mutation 動作は下記 closed v1 制約種のいずれかである。各制約は
[Object Model](./object-model.md) のどの lifecycle class がそれを使えるかを
宣言する。新規の制約種は RFC (CONVENTIONS.md §6) を要する。

| mutation-constraint | semantics                                                            | allowed lifecycle classes    |
| ------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `immutable`         | object cannot change after create; replace required for any mutation | managed, generated           |
| `replace-only`      | every mutation creates a new object and revokes the previous one     | managed, generated           |
| `in-place`          | every mutation updates the same object identity                      | managed, generated, imported |
| `append-only`       | mutations may only add; existing fields cannot change or be removed  | managed, generated, imported |
| `ordered-replace`   | replaces are serialized; no concurrent replaces in one Space         | managed, generated           |
| `reroute-only`      | object identity is fixed; mutations only re-point traffic / handles  | external, operator, imported |

`external` と `operator` lifecycle class は identity が Takosumi の外側で
所有されるため、`reroute-only` mutation しか取らない。

Mutation 制約は descriptor のメタデータである。これを実現する runtime operation
は
[Operation Plan and Write-ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
が発行し、[Object Model — Revoke participation matrix](./object-model.md) で
制約される。

## Access mode enum

Link 宣言の `access` は下記 closed v1 モードのいずれかである。これが access
語彙の canonical な home である。
[Link and Projection Model](./link-projection-model.md) と
[Namespace Export Model](./namespace-export-model.md) は再定義せずにここを
参照する。

```text
read         observation only; no grant material is generated
read-write   read plus mutation rights on the export's resource
admin        full management of the export's resource
invoke-only  may call the resource but cannot read or mutate underlying state
observe-only may only receive notifications / metrics; no resource access
```

export 宣言の `safeDefaultAccess` はこの集合から default を選べる。新規の access
mode は RFC (CONVENTIONS.md §6) を要する。

## Space-specific availability

target alias が operator catalog に存在しても、ある Space では利用不可能で
あることがある。target resolution は catalog alias resolution と Space policy
の許可の両方を要求する。
