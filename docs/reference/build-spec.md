# ビルドサービス境界 {#build-service-handoff}

Takosumi core は build を実行しません。build service、CI、operator automation
は Installer API を呼ぶ前に source を準備できます。core が受け取るのは
`source.kind: "prepared"` として渡された URL / digest / metadata だけです。

## Handoff の流れ

```text
source root
  -> build service / CI が source を準備する
  -> build service が prepared source payload を作る
  -> build service が payload digest を計算する
  -> caller が prepared source URL + digest を Installer API に渡す
  -> Installer が payload digest / path safety / size cap を検証する
  -> Installer が Deployment source identity を記録する
```

`source.digest` は Installer が取得した payload bytes の sha256 です。build graph
digest、lockfile digest、cache key、provenance digest ではありません。gzip
compressed tar の場合も digest は取得した compressed payload bytes 全体に対して
計算します。

## Prepared source archive contract

- prepared source は resolved source root を表す POSIX tar payload。
- path traversal、absolute path、NUL byte、source root 外への escape、operator
  policy の size cap 違反は side effect 前に reject する。
- repo metadata は Git URL、commit、tag、generic な `package.json` などから読む。
  Takosumi 専用 metadata field は要求しない。
- build recipe、command、cache、provenance、approval workflow は build service /
  operator automation が記録する。
- Deployment source identity は Installer が検証した source input であり、build
  recipe ではない。

## Build service profile

operator は任意の build-service profile を持てます。YAML、JSON、hosted CI
workflow、repository convention、UI 入力など、形式は operator の責務です。
Takosumi core はその profile を public contract にしません。

build service が保存してよい情報:

- build recipe と command
- dependency cache key
- source checkout と lockfile evidence
- build artifact digest
- provenance / SBOM / signature
- approval workflow record

Takosumi core に渡す情報:

- prepared source URL
- payload digest
- optional artifact digest
- source label / display metadata
- operator が選んだ `BindingSelection`

## Terraform / OpenTofu との関係

Terraform / OpenTofu は operator distribution や `takos-private/` が使う
infrastructure tool です。build service が Terraform plan を作る場合でも、state、
lock、provider credential、apply permission は operator 側に残します。
Takosumi core は Terraform を実行せず、operator catalog が公開した
PlatformService を resolve します。

## Related

- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)
- [ビルドサービス例](../operator/build-service-profile.md)
