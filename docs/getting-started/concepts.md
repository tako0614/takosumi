# コンセプト {#concepts}

## Takosumi とは

Takosumi は source repo を Space に install し、apply のたびに Deployment を記録する PaaS substrate です。

v1 は manifestless です。source root に Takosumi 専用ファイルや Takosumi 専用 metadata field を要求しません。表示名や
identity hint は Git URL、commit、tag、`package.json` などの汎用 metadata から読みます。

## 公開概念

| 概念 | 役割 |
| --- | --- |
| Source | `git` / `prepared` / `local` source input。git は commit、prepared は archive digest を resolved identity として持つ。 |
| Installation | Space に install された source record。current Deployment pointer を持つ。 |
| Deployment | 1 回の apply result。source summary、InstallPlan snapshot、binding snapshot、outputs、status を持つ。 |
| PlatformService | operator が inventory で提供する service。DB、OIDC、object store、queue、runtime endpoint など。 |

## dry-run と apply

dry-run は Installation を作らず、`InstallPlan` snapshot と `planSnapshotDigest` を返します。`InstallPlan` は persisted entity
ではありません。review 用の response snapshot です。

apply は Source を fetch / resolve し、operator inventory から PlatformService binding を解決し、Deployment に
`planSnapshot` と `bindingsSnapshot` を保存します。dry-run から apply に進む場合、`expected.planSnapshotDigest` を渡すと
review した Source / binding resolution と違う入力を 409 で止められます。

```text
Source
  -> dry-run: InstallPlan + planSnapshotDigest
  -> apply: Installation + Deployment
  -> deploy: new Deployment
  -> rollback: current Deployment pointer を戻す
```

## PlatformService

アプリが使う DB / OIDC / bucket / queue などは operator catalog の PlatformService として扱います。Terraform/OpenTofu や
cloud provider API で何を作るかは operator distribution の責務です。Takosumi core は inventory を読み、どの
PlatformService が選ばれたかを Deployment に記録します。

binding selection は install/deploy request、account-plane UI、operator policy のいずれかから渡されます。source repo 内の
Takosumi DSL で dependency graph を宣言しません。

## Terraform との関係

Terraform/OpenTofu は resource graph と state management に強い IaC です。Takosumi は Terraform を置き換えません。

推奨境界:

- Terraform/OpenTofu/Helm/Pulumi: operator-owned infra materialization と state。
- Takosumi: Source install/deploy ledger、Installation lifecycle、Deployment history、PlatformService binding snapshot。
- takosumi: account plane、billing、OIDC、dashboard、deploy facade、PlatformService inventory。

## 次に読む

- [クイックスタート](./quickstart.md)
- [Installer API](../reference/installer-api.md)
- [Takosumi core 仕様](../reference/core-spec.md)
- [プラットフォームサービス](../reference/platform-services.md)
