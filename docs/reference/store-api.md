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
3. exact SourceSnapshot の
   [Repository manifest](./repository-manifest.md)から module を選ぶ。
4. server が repository URL に一致する host policy override を一意に解決する。無い場合は
   汎用 Git InstallConfig を使い、その policy ceiling の下で exact module の
   compatibility check を実行する。
5. 選択した module path を Workspace-scoped derived InstallConfig に保存し、通常の
   review / Plan / Apply へ渡す。

Store client は `compileInstallUx: true` の request に `modulePath` や
`installConfigId` を指定できません。single-module manifest では唯一の module を選び、
multi-module manifest では `takosumi.com/v2.1` の exact `defaultModule` を要求します。
host override が複数件なら fail closed です。override が0件でも repository manifest と
汎用 host policy だけで install でき、Store への app 固有 InstallConfig 登録は不要です。

## Authority boundary

Store listing と `.well-known/tcs.json` は discovery / presentation metadata です。次の
authority を持ちません。

- module path、ref、tag、commit、SourceSnapshot、InstallConfig の選択
- input、secret、credential、provider、Interface grant、lifecycle policy の宣言
- `.well-known/takosumi.json` の代理、cache、merge、override

legacy response や presentation metadata に path が残っていても、Takosumi は module
選択に使いません。Store を切り替えても、既存 Capsule、Source、InstallConfig、Plan、
Run の authority は変わりません。

## Third-party Store

third-party Store は TCS 2.0 の read contract を実装すれば利用できます。Takosumi 固有の
install field を追加する必要はありません。listing URL はブラウザから到達可能で、
repository URL は Takosumi の Source policy を通る必要があります。authentication、
moderation、publishing は各 Store の責任であり、Takosumi の Workspace authority とは
別です。
