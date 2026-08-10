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

## Retained legacy drain

旧 Resource/Form 行を調査・削除する必要がある場合だけ、[Core Spec の legacy
drain](../internal/core-spec.md#legacy-resourceform-drain) を確認してください。drain は
既定で無効 (`404`) で、認証済み operator が明示的に有効化したときも、実装されているのは
次の限定操作だけです。

- Resource collection/record の list/read/events、observe、delete
- TargetPool/SpacePolicy record の `GET`/`HEAD`/list、delete

drain は Form を作成・activate・discover せず、Resource の desired state を受け取りません。
旧 Resource の preview/apply/recover/import/refresh や、Form Registry、FormActivation、
TargetPool/SpacePolicy の write を復活させる設定ではありません。対象が単なる旧行の
観察・削除を越える場合は、この OSS 文書から手順を推測せず、該当する外部 Host または
provider の owner に移行計画を確認してください。

## 関連

- [Takosumi Core Spec](../internal/core-spec.md)
- [実行モデル](../concepts/run-model.md)
- [状態と出力](../concepts/state-and-outputs.md)
- [Resource migration internals](../concepts/resources.md)
