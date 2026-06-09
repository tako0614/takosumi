# Takosumi

Takosumi は **Space 直下の OpenTofu Capsule DAG を管理する OSS control plane** です。ユーザーは任意の Git URL から OpenTofu Capsule を Space (`@handle`) にインストールします。Takosumi はその Capsule を child module として呼べる形に正規化し、generated root で包み、OpenTofu の plan / apply / destroy を実行し、state 世代、outputs、Installation 間の依存 DAG、credentials、artifacts、activity、billing mode を管理します。

OpenTofu configuration が resource definition です。Takosumi は独自 manifest や別の infrastructure 定義形式を要求しません。repo の Git URL、commit、module path、OpenTofu provider lock、Compatibility Report、`tofu plan`、`tofu output -json`、Run ledger から必要な情報を記録します。

正本仕様は [Core spec](./core-spec.md) です。現時点の実装適合状況と追加拡張の候補は [Core conformance](./core-conformance.md) に分けて記録します。

## 何をするか

1. Operator が Provider Templates、operator default connections (Takosumi提供は Cloudflare only)、billing mode (`disabled` / `showback` / `enforce`) を用意します。
2. User または dashboard が Git URL を Source として登録し、Space 直下に Capsule Installation を作ります (`@space/name`)。
3. Compatibility Check が SourceSnapshot を固定し、Capsule Normalizer と Capsule Gate で Ready / Auto-capsulized / Needs patch / Unsupported を判定します。
4. Plan Run が DependencySnapshot と base StateSnapshot generation を固定し、generated root を作り、provider credentials を mint して `tofu plan -out=tfplan` と `tofu show -json` を実行します。
5. Policy は Compatibility Report と plan JSON を、provider / module source / data source / resource allowlist、action policy、dependency policy、output policy、quota、billing reservation で評価します。
6. 承認が必要な plan (destroy / destructive change) は approve を経て apply されます。apply は saved plan のみを実行し、plan digest / source snapshot / compatibility report / dependency snapshot / state generation を検証します。
7. 成功した apply は StateSnapshot 世代を進め、OutputSnapshot (spaceOutputs / publicOutputs、raw は暗号化 artifact) と Deployment を記録し、UsageEvent / CreditReservation を確定し、downstream Installation を stale にします。

Runner-backed Capsule Normalizer / Capsule Gate、Compatibility Report の plan/apply guard、root-only provider credential mint、Cloudflare / AWS の TTL evidence、billing showback/enforce、meter reconciliation の基本 path は実装済みです。Provider Templates / Provider Env Set の2種類モデルを正本 model として扱います。

## 何ではないか

Takosumi は OpenTofu の置き換えではありません。resource graph、provider schema、state operation、drift detection の正本は OpenTofu です。

Takosumi は Provider Templates を持ちますが、OpenTofu provider ecosystem を置き換える registry ではありません。provider credential は Takosumi提供またはユーザーenvセットのどちらかとして Connection / vault が保持します。ProviderBinding は Installation provider binding を `default` / `connection` / `manual` / `disabled` のいずれかに解決するだけです。

Takosumi は 2 層 product ではありません。managed dashboard、account plane、control plane は同じ Takosumi distribution の operator-facing surface です。

## Public surface

| Concept              | Meaning                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space                | GitHub の user/org に近い owner namespace (`@handle`)。members / sources / connections / installations / dependency graph / policy / activity / optional billing を持つ                                                      |
| Source               | 登録された Git repository。immutable な SourceSnapshot (commit 固定 + digest) を生む                                                                                                                                         |
| Connection           | 外部接続 (Git token / SSH key / Cloudflare token 等)。scope は operator / space。Installation は provider ごとに ProviderBinding (default / connection / manual / disabled) で束ねる                                     |
| ProviderBinding    | Installation provider binding (provider source / optional provider alias / database / secrets) を default / connection / manual / disabled のいずれかで解決する binding                                         |
| Provider Templates   | provider source / credential sources / recommended env names / helper を定義。Takosumi提供は Cloudflare only から始める                                                                                                             |
| Provider Env Set     | Space が任意 OpenTofu provider の env credential set を追加する仕組み。secret 値は write-only で、public API は envNames だけを返す                                                                                           |
| OpenTofu Capsule     | Git URL から取得する OpenTofu module-compatible configuration。Normalizer / Gate が supporting Compatibility Report を作り、generated root から呼ばれる                                                                                                        |
| Installation         | Space 直下の Capsule + generated root + StateSnapshot + OutputSnapshot + Deployment の単位 (`@space/name`)。InstallConfig (trust / modulePath / normalization / variable mapping / output allowlist / policy) が扱いを決める |
| DeploymentProfile    | Installation / environment ごとの ProviderBinding set。provider source / optional provider alias を Connection に解決する                                                                                                          |
| Dependency           | producer outputs → consumer inputs の DAG edge (variable_injection が標準)。plan 時に DependencySnapshot で固定                                                                                                              |
| Run                  | 1 回の実行 (source_sync / compatibility_check / plan / apply / destroy_plan / destroy_apply / drift_check / backup / restore)                                                          |
| RunGroup             | Space 更新や Installation 更新など、DAG 順の複数 Run を束ねる orchestration record                                                                                           |
| Deployment           | 成功した apply の ledger record (active → superseded / destroyed)                                                                                                                                                            |
| OutputSnapshot       | apply 後の `tofu output -json` 世代。spaceOutputs / publicOutputs に projection、raw は暗号化 artifact                                                                                                                       |
| Billing              | Space 単位の credit / usage ledger。`disabled` は非表示、`showback` は記録のみ、`enforce` は apply 前の credit reservation で gate する                                                                                      |
| Activity             | Space 単位の audit trail                                                                                                                                                                                                     |

次に読む: [Quickstart](./getting-started/quickstart.md)
