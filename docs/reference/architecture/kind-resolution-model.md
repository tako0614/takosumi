# Adapter Resolution モデル {#adapter-resolution-model}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) と [Platform Services](../platform-services.md) を参照。
:::

Takosumi v1 の Source authoring は manifestless です。Repository identity は git / prepared / local Source input と generic metadata から解決され、依存先は operator が持つ PlatformService inventory と install / deploy request の `BindingSelection` から決まります。

## Public input {#public-input}

Installer API の public input は Source と expected guard です。

```json
{
  "spaceId": "space_acme",
  "source": {
    "kind": "git",
    "url": "https://github.com/acme/app.git",
    "ref": "main"
  },
  "bindings": {
    "database": {
      "serviceId": "svc_postgres_primary"
    }
  }
}
```

Provider selection and adapter-specific runtime input are operator resolution concerns, not public v1 Source fields.

## Operator resolution {#operator-resolution}

Resolution は operator-owned で、決定的かつ fail-closed にする。Takosumi はその結果を Deployment evidence として記録します。

```text
1. Resolve Source identity:
   - git commit
   - prepared source digest
   - local source snapshot digest
2. Read operator PlatformService inventory visible to the Space.
3. Apply request / account-plane BindingSelection and operator policy.
4. Resolve selected PlatformService records and implementation bindings.
5. Produce InstallPlan with source summary, binding preview, risk, and outputs.
6. Apply persists Deployment with source summary, planSnapshot,
   planSnapshotDigest, bindingsSnapshot, outputs, and status.
```

`InstallPlan` は review 用 response snapshot であり persisted public entity ではありません。`planSnapshotDigest` は dry-run で確認した source + binding resolution と apply 時の入力がずれていないことを守る expected guard です。

## Reference adapter metadata {#reference-adapter-metadata}

`https://takosumi.com/kinds/v1/*` JSON-LD documents は reference adapter metadata です。operator distribution はこの metadata を採用して adapter validation や connector discovery に使えますが、Source repo が直接書く public contract ではありません。

```text
Reference adapter metadata:
  descriptor identity
  implementation helper terms
  optional validation metadata
  material / projection helper vocabulary

Operator inventory:
  PlatformService records visible to a Space
  policy / approval / ownership metadata
  provider credentials and implementation binding
```

Takosumi は mandatory global kind catalog を要求しません。互換 operator は同じ Installer API と Deployment record を保ったまま、OpenTofu output、native controller、workflow engine、SaaS adapter、static inventory などで PlatformService inventory を作れます。

## Access mode enum {#access-mode-enum}

resolved access は official [Access modes](../access-modes.md) で定義された closed v1 モードのいずれかです。access は Source file ではなく、operator policy、BindingSelection、PlatformService policy、approval から resolution 中に決まります。

```text
read         observation only; no authorization material is generated
read-write   read plus mutation rights on the source resource
admin        full management of the source resource
invoke-only  may call the resource but cannot read or mutate underlying state
observe-only may only receive notifications / metrics; no resource access
```

operator policy が明示的に access mode を選ぶ場合は、この閉じた集合から選びます。`read-write` と `admin` は default にせず、operator policy / approval が resolution 時に明示選択します。新規の access mode は RFC を要します。

## Space availability {#space-specific-availability}

PlatformService や adapter implementation が operator distribution に存在しても、ある Space では利用不可能なことがあります。Resolution は service visibility、ownership、policy、approval、implementation readiness をすべて満たす必要があります。未解決、曖昧な selection、policy denial は resource side effect 前に fail-closed で返します。
