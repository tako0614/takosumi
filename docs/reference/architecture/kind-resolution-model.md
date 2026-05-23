# Kind Resolution モデル {#kind-resolution-model}

> このページでわかること: component kind から implementation binding
> を決める境界。

public AppSpec は `components.<name>.kind` と kind-specific な open `spec` から
runtime intent を表す。component kind の意味と input schema は JSON-LD
descriptor が表し、provider mapping と Space policy は operator distribution が
定義する。

## Public な component kind {#public-component-kind}

```yaml
components:
  api:
    kind: worker
	    spec:
	      entrypoint: dist/worker.mjs
```

kind resolution は `components.<name>.kind` から始まる。short alias を使う場合は
operator が `kindAliases` で明示的に opt-in したものだけが解決される。解決された
provider implementation は Deployment の証拠であり、component kind の semantic
identity とは別に記録される。

## External kind descriptor {#external-kind-descriptor}

external kind descriptor は operator / registry が必要に応じて採用する semantic
data です。descriptor は例えば次を定義できます。

```text
input schema
possible exports
projection capabilities
operation capabilities
mutation constraints
implementation requirements
```

DataAsset を扱う場合、operator extension の policy として扱います。

## Kind / provider resolution {#kind-provider-resolution}

resolution は operator-owned で、決定的かつ fail-closed にする。kernel は
AppSpec を受け、Installation に紐づく Deployment として resolution evidence
を記録する。

```text
1. Read `components.<name>.kind`.
2. If the value is a short alias, resolve it through operator-injected
   `kindAliases`; unresolved aliases fail before provider side effects.
3. Select the kind descriptor for the resolved URI.
4. Validate `spec` against the selected kind descriptor input schema.
5. Select an implementation binding visible to the Space, then apply provider
   support, capability, and Space policy checks.
6. Record the chosen materializer/provider evidence in the internal Deployment
   ledger, and expose only component JSON outputs through public Deployment
   outputs.
```

`https://takosumi.com/kinds/v1/*` reference descriptors may be one input to this
process as external reference descriptor examples.

## Component 入力スキーマ {#input-schema}

Component input 検証は `components.<name>` を `components.<name>.kind`
で選ばれた component kind contract に対して validate する。provider のサポートと
capability 制約は provider resolution の段階でチェックされる。

```text
JSON-LD / descriptor:
  identity and semantic relations

Input schema:
  component `spec` validation

Policy:
  allow / deny / approval

Implementation binding:
  external consistency and smoke checks
```

## Mutation 制約 {#mutation-constraints}

mutation 動作は external component kind / provider contract が定義する。下記は
reference descriptor で使える vocabulary の例です。

| mutation-constraint | semantics                                                            | allowed lifecycle classes    |
| ------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `immutable`         | object cannot change after create; replace required for any mutation | managed, generated           |
| `replace-only`      | every mutation creates a new object and revokes the previous one     | managed, generated           |
| `in-place`          | every mutation updates the same object identity                      | managed, generated, imported |
| `append-only`       | mutations may only add; existing fields cannot change or be removed  | managed, generated, imported |
| `ordered-replace`   | replaces are serialized; no concurrent replaces in one Space         | managed, generated           |
| `reroute-only`      | object identity is fixed; mutations only re-point traffic / handles  | external, operator, imported |

`external` と `operator` lifecycle class は external identity を参照するため、
`reroute-only` mutation を取る。

Mutation 制約は descriptor のメタデータである。これを実現する runtime operation
は
[Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
が発行し、[Object Model — Revoke participation matrix](./object-model.md) で
制約される。

## Access mode enum {#access-mode-enum}

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

## Space 固有の availability {#space-specific-availability}

kind alias や provider implementation が operator registry に存在しても、ある
Space では利用不可能であることがある。resolution は alias / implementation
binding と Space policy の許可の両方を要求する。
