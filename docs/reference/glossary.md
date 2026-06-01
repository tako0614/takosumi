# 用語集 {#glossary}

## Public Concepts

### Source

Installer API に渡す repository または prepared artifact。`git`、`prepared`、`local`
の 3 種を扱う。Takosumi は Git URL、commit、tag、source digest、artifact digest、
generic な `package.json` metadata などから表示用 metadata と source identity
を作る。

### Installation

Space に install された Source の record。current Deployment pointer、Space、
repo metadata、最新の公開 output を持つ。ownership、team membership、billing
は operator distribution が持つ。

### Deployment

Install または deploy apply で作られる 1 回分の immutable record。source
identity、`planSnapshotDigest`、`planSnapshot`、`bindingsSnapshot`、status、
non-secret outputs を保存する。rollback は retained Deployment を current
pointer に戻す操作であり、Source を再解決しない。

### PlatformService

operator catalog / inventory が Space に公開する service capability。例は OIDC
issuer、Postgres、object storage、queue、MCP server、runtime target。Takosumi
core は PlatformService を作らず、request / account-plane UI / operator policy
から渡された `BindingSelection` を catalog resolver で解決する。

### InstallPlan

dry-run response にだけ返る review 用 snapshot。永続化されない。apply は
review 済み plan と同じ Source / binding selection であることを
`planSnapshotDigest` によって検証する。

### BindingSelection

install / deploy request、operator policy、または account-plane UI が選ぶ
PlatformService binding。Takosumi core は selection を operator catalog resolver
に渡し、Deployment には解決済み binding snapshot を保存する。

### Operator

Takosumi を起動し、catalog / inventory、runtime adapter、storage、secret
store、Terraform/OpenTofu state、billing、OIDC、dashboard、approval policy を持つ
主体。Takosumi は reference operator distribution の 1 つ。

### Space

Installation を収容する operator-owned isolation 単位。Takosumi core は
`spaceId` を記録するが、membership、quota、billing subject、service visibility
は operator distribution が決める。

### dry-run

side effect なしで source fetch、metadata extraction、binding resolution、
operator policy validation を行い、`InstallPlan`、`changes[]`、`expected` guard
を返す操作。

### apply

dry-run で確認した Source と binding selection を Deployment として記録する操作。
apply は `expected.planSnapshotDigest` や current pointer guard が一致しない場合に
409 を返す。

### expected guard

review した入力と apply する入力が同じであることを確認する TOCTOU guard。
`commit`、`sourceDigest`、`artifactDigest`、`planSnapshotDigest`、
`currentDeploymentId` などを持つ。

### Prepared source

CI、build service、operator automation が作る source handoff artifact。Installer
API は fetched payload bytes の sha256 を source identity として扱う。build
recipe、cache key、provenance は operator / build service の record に置く。

### planSnapshotDigest

dry-run で返した `InstallPlan` snapshot の digest。apply はこの digest を guard
として受け取り、review 済み plan と違う source / binding selection を止める。

### sourceDigest / artifactDigest

prepared source や build artifact の byte digest。どの artifact を source
identity として扱うかは Installer API request と operator policy に従う。

## Boundaries

### Terraform / OpenTofu

infrastructure creation、provider state、lock、credentials は operator distribution
または `takos-private/` の責務。Takosumi core は Terraform を実行せず、operator
catalog が公開した PlatformService を参照する。

### Operator catalog / inventory

PlatformService、runtime target、binding implementation、service visibility を
記録する operator-owned source of truth。Takosumi core は catalog resolver を
呼び、Deployment に selected binding snapshot を残す。

### Runtime adapter

Takosumi reference kernel が host runtime の差を吸収する境界。kernel core は
直接 host API に依存せず、`src/kernel/shared/runtime/` 経由で filesystem、env、
server、subprocess、clock を扱う。

### Account layer

account、billing、OIDC issuer、dashboard、approval workflow、deploy facade を
提供する operator-owned layer。Takosumi core の public record は Source、
Installation、Deployment、PlatformService に閉じる。

## Related Pages

- [本体仕様](./core-spec.md)
- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)
- [ビルドサービス境界](./build-spec.md)
