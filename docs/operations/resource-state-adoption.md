# Retired Resource state adoption (superseded)

> このページは、旧 Resource Shape が backing Capsule の state を持っていた時期の
> operator runbook です。現行の Takosumi OSS では、この Resource-owned lifecycle や
> state adoption 手順を実行しません。旧手順を現在の操作として再利用しないでください。

## 現在の state の扱い

現行の product flow は、Git の OpenTofu / Terraform module を実行する Stack です。
Takosumi が持つ実行記録は `Run`、成功した state の世代は `StateVersion`、公開値は
`Output` です。[実行モデル](../concepts/run-model.md) と
[状態と出力](../concepts/state-and-outputs.md) が current owner docs です。

既存の provider object を module に引き継ぐ場合は、provider と OpenTofu が定める
import/state 手順を module 側に記述し、Git source と provider lock を固定して、通常の
Stack の plan と apply を使います。Takosumi の旧 Resource endpoint、旧 Form Host、または
手作業で推測した state object key を経由しません。plan の内容を確認し、同じ Run を
apply して、成功後に作られた `StateVersion` と `Output` を確認します。

OpenTofu state に含まれ得る provider の secret は control object や Output にコピー
しません。state bytes を手動で移動・編集したり、別の Capsule や Workspace から推測して
採用したりしないでください。

## 既存の Takosumi StateVersion に戻す場合

既存の Stack state を使い続ける必要がある場合は、Capsule の StateVersion 履歴を読み、
通常の rollback plan と Run の承認・apply を使います。

```text
GET  /api/v1/capsules/{capsuleId}/state-versions
POST /api/v1/state-versions/{stateVersionId}/rollback-plan
```

StateVersion を選んだだけでは state は変わりません。作られた Run の plan を確認し、
同じ Run を apply します。戻した結果は新しい StateVersion として記録されます。commit が
存在しない、Workspace / Capsule が一致しない、または plan に意図しない破壊的変更がある
場合は停止し、operator と provider の復旧計画を見直します。

## Retained Resource data

Retained Resource/Form rows are migration data only. The former `/v1`
Resource, TargetPool, and SpacePolicy HTTP families are unconditionally
retired (`404`) and have no drain flag or CLI caller. Use typed in-process
operations, a controlled database migration, or the owning external Host for
any inspection or transition; do not infer an HTTP compatibility alias from
this runbook.

## 関連

- [Takosumi Core Spec](../internal/core-spec.md)
- [実行モデル](../concepts/run-model.md)
- [状態と出力](../concepts/state-and-outputs.md)
- [Resource migration internals](../concepts/resources.md)
