# アカウント管理の Ownership Ledger {#account-plane-ownership-ledger}

ownership ledger は Takosumi のアカウント管理投影です。Takosumi の Installation (アプリのインストール記録) / Deployment (デプロイの実行記録) record の周囲で、owner、billing、revoke、export を説明します。OAuth だけでは「誰がこの Installation を管理するか」「誰に課金するか」「誰が revoke / export できるか」は決まりません。

## Ownership Chain

```text
TakosumiAccount
  -> Space
  -> CloudInstallationProjection
      -> BindingMaterialRecord[]
      -> CloudCapabilityGrant[]
      -> InstallationEvent[]
```

Takosumi はソースのチェック、install / deploy lifecycle、Deployment apply / rollback、current Deployment pointer の authority です。Cloud は account、 Space、billing owner、launch token、capability、PlatformService inventory、投影 state を管理します。

## Projection Status

Cloud status values:

```text
installing | ready | failed | suspended | exported
```

deploying、rolling back、materializing、exporting、importing などの in-flight work は operation metadata と event で表し、public status value は増やしません。

## Runtime Mode

```text
shared-cell | dedicated | self-hosted
```

runtime mode は Cloud 投影 state です。manifest field でも Takosumi Installer API status でもありません。

## Capability Grants

Cloud capability grant は operator policy、adopted kind の定義、operator が提供する外部サービスの resolution、product profile policy から導出されるアカウント管理の ledger state です。manifest field ではなく、base profile に public grant-management route はありません。

Cloud base profile examples:

```text
deploy.intent.write
logs.read.own
billing.usage.report
```

product profile は自分の capability vocabulary を管理します。
