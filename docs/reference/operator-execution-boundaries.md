# Operator Execution Boundaries

Operator execution boundary は、OpenTofu をどこでどう実行するかの内部設定です。
public な製品用語ではありません。

## Owns

- runner substrate
- executor registry adapter bindings
- typed profile lifecycle and availability
- runner image
- queue / worker binding
- resource limits
- explicit provider deny policy
- network egress policy
- state/lock backend references
- secret exposure policy

## Does Not Own

- raw provider secret values
- ProviderConnection public identity
- public compatibility API contract
- adapter capability contract
- official managed target pools
- official managed resource backends
- Takosumi-owned native resource internals

Provider credential は ProviderConnection / vault に置かれます。この boundary は、
policy が Run の実行を許可した後にだけ、一時的な run-scoped の材料を受け取ります。

## Resolved Execution View

```json
{
  "id": "opentofu-default",
  "substrate": "operator-managed",
  "executorId": "opentofu.default",
  "lifecycle": { "state": "active" },
  "availability": { "state": "available" },
  "stateBackend": {
    "kind": "operator-managed",
    "ref": "state://takosumi/opentofu-default",
    "lock": { "kind": "operator", "ref": "lock://takosumi/opentofu-default" }
  },
  "allowedProviders": ["*"],
  "requireProviderBindings": false,
  "networkPolicy": { "mode": "operator-managed" },
  "resourceLimits": {
    "maxRunSeconds": 900,
    "maxSourceArchiveBytes": 104857600,
    "maxSourceDecompressedBytes": 1048576000,
    "memoryMb": 1024
  },
  "secretExposurePolicy": {
    "providerCredentials": "runner-only",
    "redactLogs": true,
    "blockSensitiveOutputs": true
  }
}
```

`opentofu-default` は provider-neutral です。文法的に正しいすべての provider source は
この実行経路を使い、Takosumi は verified / unverified / guided / generic のような
provider 実行 tier を維持しません。Credential Recipe は設定の利便性を足すだけです。
Provider package は、cache や mirror があればそれを使い、なければ OpenTofu の通常の
registry インストール経路を使います。

Operator は、private network、host agent、architecture、compliance boundary のような
実行 capability のための追加 profile を定義できます。これらの profile は明示的に選択され、
provider brand によって命名・選択されてはいけません。明示的な deny policy や不足している
runtime capability は Run を拒否できますが、Takosumi の recipe 一覧に載っていないことを
理由に拒否することはできません。

標準の Worker が提供するのは `opentofu-default` だけです。組み込み側の Worker は、
追加の `profiles` と任意の `executors` map を持つ runtime の
`TAKOSUMI_RUNNER_HOST_COMPOSITION` object を注入し、`TAKOSUMI_ENABLED_RUNNER_PROFILES`
で profile id を明示的に有効化し、`TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID` で fallback を
選べます。この寄与は host 側のコードであり、テキストの catalog、repository manifest、
OpenTofu Output ではありません。重複した profile id と未登録の executor は fail closed
します。

`executorId` は、注入された executor registry によってのみ解決される open な
operator 定義 token です。label は説明/検索用の metadata であり、lifecycle、
availability、scheduling、executor の選択を変えることはできません。未登録の executor は
fail closed します。

## Secret Exposure

`providerCredentials: "runner-only"` は、provider credential が runner の dispatch
経路の内部でのみ解決されることを意味します。承認済みの env/file channel を通して注入され、
`.tfvars`、run log、public API の projection、tenant workload を経由することはありません。

## Managed-Capacity Boundary

Operator execution の設定は、Run がどこで実行されるか、resolver がどの adapter を
使えるかを選べますが、public な compatibility API framework を定義するものではありません。
Workers for Platforms dispatch、Takosumi 所有の native resource internals、
official managed target pool、official resource backend は Operator/Cloud の
managed-capacity 領域の関心事です。OSS repo は、これらを既定の operator execution 経路
として公開してはいけません。
