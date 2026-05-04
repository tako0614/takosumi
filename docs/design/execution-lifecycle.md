# Execution Lifecycle

Execution Lifecycle は、manifest / AppSpec / Deployment desired state を実際の
provider operation へ変換する層である。ここでは plan は副作用を持たず、apply /
destroy / status / rollback が state と provider handle を扱う。

## Plan

次期 `takosumi plan` は以下を行う。

1. manifest を parse する。
2. `takosumi.lock` を読む。
3. plugin dependency を解決する。
4. plugin exports を registry に登録する。
5. bundle component を concrete components に展開する。
6. component name uniqueness を検証する。
7. contract schema を検証する。
8. provider が contract を実装しているか検証する。
9. references から DAG を構築する。
10. cycle を検出する。
11. current state と desired state を比較する。
12. create / update / delete / no-op を算出する。
13. expanded components、selected providers、policy decisions、warnings を表示
    する。

plan は副作用を持たない。provider 側の read が必要な場合も、それは observation
として扱い、desired state とは分離する。

## Apply

`takosumi apply` / `takosumi deploy` は plan と同じ resolution を行い、lock
digest を deployment record に保存し、topological order で component を apply
する。

apply の原則:

- lock 済み plugin だけを実行対象にする。
- component DAG order で provider apply を呼ぶ。
- provider outputs を収集する。
- secret outputs は raw value として core に保存しない。
- component state と provider handle を保存する。
- status / observe を実行する。
- failure 時は可能な範囲で rollback / compensation を行う。

## Current ApplyV2

現行 CLI-facing apply pipeline は `applyV2` である。

flow:

1. `resolveResourcesV2(resources)` で `(shape, provider, spec)` を解決する。
2. shape / provider / capability / spec validation issue があれば
   `failed-validation` で止め、provider は呼ばない。
3. `${ref:...}` / `${secret-ref:...}` から DAG を構築する。
4. cycle / unknown ref は `failed-validation`。
5. DAG order で `provider.apply(resolvedSpec, context)` を呼ぶ。
6. apply 成功ごとに `handle`, `outputs`, `specFingerprint` を記録する。
7. apply 失敗時は、それまで apply 済み resource を逆順に best-effort destroy
   する。
8. 成功時は `recordStore.upsert(...)` で deployment record に保存する。

fingerprint は次の seed の FNV-1a 32-bit である。

```text
shape | providerId | name | JSON.stringify(resolvedSpec)
```

`priorApplied` snapshot があり、fingerprint と provider id が一致する場合、
`provider.apply` は呼ばず、保存済み handle / outputs を再利用する。

現行 v0 policy では、fingerprint mismatch でも旧 handle を自動 destroy しない。
旧 resource は残ったまま `provider.apply` が再実行される。将来の delta replace
で置き換える余地がある。

source:

- `docs/reference/lifecycle.md`
- `packages/kernel/src/domains/deploy/apply_v2.ts`
- `packages/kernel/src/domains/deploy/resource_resolver_v2.ts`
- `packages/kernel/src/domains/deploy/ref_resolver_v2.ts`

## Destroy

`destroyV2` は apply と同じ validation / DAG resolution を流し、逆 DAG 順で
`provider.destroy(handle, ctx)` を呼ぶ。

現行 public deploy route の destroy semantics:

- prior record がない場合は 409 `failed_precondition`。
- `force: true` の場合は resource name を handle として fallback する。
- cloud handle と一致しない可能性があるため warning を残す。
- per-resource failure は `errors[]` に積み、全体は continue する。
- 成功 / 部分成功後は record を `destroyed` に mark する。

source:

- `docs/reference/lifecycle.md`
- `packages/kernel/src/domains/deploy/destroy_v2.ts`
- `packages/kernel/src/domains/deploy/takosumi_deployment_record_store.ts`

## Status And Observation

runtime status は persistent record 取得と runtime-agent describe
が分かれている。runtime-agent の `describe` は connector が実 cloud / OS state
を問い合わせる。戻り値は `running`, `stopped`, `missing`, `error`, `unknown`
である。

Core deployment 側では observed state は `ProviderObservation` として保持する。
observed state は desired state の正本ではない。drift や provider failure は
conditions と observation に表す。

## Rollback

rollback は 2 系統ある。

| Flow                       | Role                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `applyV2` failure rollback | 同一 process 内で apply 済み resource を best-effort destroy     |
| Core `rollbackGroup`       | retained Deployment / GroupHead history で過去 generation へ戻す |

Core の rollback は過去 Deployment を再び current head にする operation である。
単に provider object を戻すだけではなく、deployment record、activation
envelope、route assignment、policy decisions の整合性を持つ。

## Concurrency

in-process では `(tenantId, name)` の Promise chain lock で apply / destroy を
serialize する。

cross-process / multi-pod lock は SQL store だけでは保証しない。multi-pod
self-host では single-writer apply tier か row-level lock を持つ custom SQL
implementation が必要である。

source:

- `docs/operator/self-host.md`
- `packages/kernel/src/domains/deploy/takosumi_deployment_record_store_sql.ts`

## Runtime Agent

runtime-agent は kernel から見た data plane である。cloud credential / OS access
は runtime-agent host に置き、kernel は lifecycle envelope を HTTP POST する。

endpoint:

| Method | Path                     | Purpose                                         |
| ------ | ------------------------ | ----------------------------------------------- |
| `GET`  | `/v1/health`             | health check                                    |
| `GET`  | `/v1/connectors`         | registered connector と accepted artifact kinds |
| `POST` | `/v1/lifecycle/apply`    | resource create / update                        |
| `POST` | `/v1/lifecycle/destroy`  | handle 指定 destroy                             |
| `POST` | `/v1/lifecycle/describe` | handle 指定 status                              |
| `POST` | `/v1/lifecycle/verify`   | credential / network smoke test                 |

auth は `TAKOSUMI_AGENT_TOKEN` の bearer token である。`/v1/health` のみ無認証。

runtime-agent connector は `acceptedArtifactKinds` を持ち、`spec.artifact.kind`
が受理できない場合は dispatcher が拒否する。

source:

- `docs/reference/runtime-agent-api.md`
- `packages/contract/src/runtime-agent-lifecycle.ts`
- `packages/runtime-agent/src/server.ts`
