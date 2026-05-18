# AppSpec Dependency Semantics

> このページでわかること: current AppSpec の component dependency / binding
> semantics。旧 compiled Manifest の `${ref:...}` placeholder 文法は current
> public AppSpec には存在しない。

## Source form

AppSpec は `.takosumi.yml` の `components` map だけを public dependency source
として扱う。component 間の依存は `use:` edge で明示する。

```yaml
components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    use:
      db:
        env: DATABASE_URL
      assets:
        envPrefix: ASSETS_
  db:
    kind: postgres
  assets:
    kind: object-store
```

`use:` の key は同じ AppSpec 内の component 名。value は producer output を
consumer に渡す binding rule で、current v1 は次を持つ。

| Field       | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `env`       | producer の primary output を 1 つの environment へ渡す  |
| `envPrefix` | producer outputs を prefix 付き environment set へ渡す   |
| `mount`     | reserved mount point。current v1 は `oidc` のみ          |
| `target`    | 同 kind の複数 target を区別する operator-owned selector |

## Validation

installer / kernel は AppSpec parse 時に dependency graph を作る。

- `use:` target は同じ `components` map に存在しなければならない。
- self-reference は禁止。
- cycle は禁止。
- `mount: oidc` は `kind: oidc` component にだけ使える。
- `${ref:...}` / `${secret-ref:...}` / `${bindings.*}` / `${secrets.*}` /
  `${installation.*}` / `${artifacts.*}` / `${params.*}` は current AppSpec では
  invalid syntax。

validation error は apply 前に surface し、resource は materialize されない。

## Apply order

apply pipeline は `use:` graph から topological order を決める。独立 component
は並行実行できるが、consumer component は producer outputs が確定した後に
materialize される。

provider output は raw string interpolation ではなく、binding rule に従って
runtime desired state に注入される。secret raw value は AppSpec に戻さない。
provider が secret を出す場合は secret-store boundary を通した reference として
扱う。

## Cross-space boundary

current AppSpec の `use:` は同じ AppSpec 内の component に閉じる。Space 間共有は
AppSpec placeholder ではなく、Namespace Export / Binding contract の責務。

## Related architecture notes

- [Manifest Validation](/reference/manifest-validation)
- [AppSpec](/reference/app-spec)
- [Namespace Exports](/reference/namespace-exports)
- [OperationPlan / WAL](/reference/architecture/operation-plan-write-ahead-journal-model)
- [Closed Enums](/reference/closed-enums)
