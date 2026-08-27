# Store API

Takosumi は、TCS 2.0 compatible Store を Capsule の発見 UI として利用できます。
TCS の wire contract は Takosumi ではなく Store project が所有します。field、route、
pagination、error envelope の正本は
[TCS 2.0 specification](https://github.com/tako0614/takosumi-store/blob/main/docs/SPEC-v2.md)、
動く server の例は
[Takosumi Store reference implementation](https://github.com/tako0614/takosumi-store)
を参照してください。このページでは Takosumi 側の integration boundary だけを定義します。

## Install handoff

TCS 2.0 listing から install authority として Takosumi が受け取るのは Git repository
URL だけです。suggested name や表示情報は UI の初期値にできますが、実行対象を決めません。

1. dashboard が listing の repository URL を受け取る。
2. Takosumi がその URL の Source を root から sync し、ref を immutable commit に固定する。
3. exact SourceSnapshot の tracked OpenTofu file scan から module 候補と provider requirement
   を取得する。候補が1件なら自動選択し、複数なら利用者が選択する。
4. server が repository URL に一致する host policy override を一意に解決する。無い場合は
   汎用 Git InstallConfig を使い、その policy ceiling の下で exact module の
   compatibility check を実行する。
5. 選択した module path を Workspace-scoped derived InstallConfig に保存し、通常の
   review / Plan / Apply へ渡す。

Store client は `compileInstallUx: true` の request に `modulePath` や
`installConfigId` を指定できません。候補が0件なら install 不可、1件なら自動選択、複数なら
dashboard の chooser で exact path を明示します。host override が複数件なら fail closed
です。override が0件でも optional repository manifest と
汎用 host policy だけで install でき、Store への app 固有 InstallConfig 登録は不要です。
host override は `sourceSelector.url` で一致する実行 policy であり、`store` 表示情報を
持つ必要はありません。そのため lifecycle や credential policy を許可する operator
設定が Store の別 listing として表示されることもありません。

## Authority boundary

Store listing と `.well-known/tcs.json` は discovery / presentation metadata です。次の
authority を持ちません。

- module path、ref、tag、commit、SourceSnapshot、InstallConfig の選択
- input、secret、credential、provider、Interface grant、lifecycle policy の宣言
- `.well-known/takosumi.json` の代理、cache、merge、override

legacy response や presentation metadata に path が残っていても、Takosumi は module
選択に使いません。Store を切り替えても、既存 Capsule、Source、InstallConfig、Plan、
Run の authority は変わりません。

## Discovery and local search

Takosumi が Store に必須とする discovery interface は server info、paginated listings、
listing detail だけです。Dashboard は取得済み listing の表示 metadata をローカル検索し、
TCS 2.0 で予約されている `/tcs/v2/listings/search` を呼びません。未取得 page がある場合は
「さらに読み込む」で検索対象を増やします。

したがって server-side search の未実装や失敗を、Store 全体の到達不能、Git repository
URL の発見失敗、または追加不可へ昇格させてはいけません。Store の目的は Git URL の発見で
あり、検索 index や install policy の提供ではありません。

## Third-party Store

third-party Store は TCS 2.0 の read contract を実装すれば利用できます。Takosumi 固有の
install field を追加する必要はありません。listing URL はブラウザから到達可能で、
repository URL は Takosumi の Source policy を通る必要があります。authentication、
moderation、publishing は各 Store の責任であり、Takosumi の Workspace authority とは
別です。
