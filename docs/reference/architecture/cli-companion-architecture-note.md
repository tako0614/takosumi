# CLI Surface アーキテクチャ {#cli-surface-architecture}

`takosumi` CLI は Installer API と operator read projection の thin client。
authority は kernel と operator distribution 側にあり、CLI は AppSpec source と
command intent を運ぶだけである。

## 権限境界 {#authority-boundary}

- public source of truth は `.takosumi.yml` (= AppSpec)。
- CLI は provider selection、Space entitlement、risk evaluation、quota decision
  を自前で確定しない。
- Space / actor の解決は installer token issuer と kernel context の責務。
- CLI は AppSpec source を 5 endpoint Installer API に渡し、response
  を表示する。

## モード {#modes}

- **remote**: `--remote` / `TAKOSUMI_REMOTE_URL` / config で kernel URL が
  resolve された場合。`TAKOSUMI_INSTALLER_TOKEN` を installer bearer
  として使う。
- **local**: remote URL が無い場合の authoring / test fixture 用。永続 state や
  multi-actor auth を前提にする command は local で提供しない。

`takosumi server` は local kernel host を起動し、その後の CLI invocation は
`http://localhost:<port>` に対する remote mode と同じ扱いになる。

## コマンド surface {#command-surface}

current public lifecycle command は public Installer API の 5 endpoint
に対応する。

- `install`
- `install dry-run`
- `deploy`
- `deploy dry-run`
- `rollback`

Installation / Deployment ledger reads use the operator read projection. They
are not additional write lifecycle endpoints. reference kernel では internal
control-plane route を使う operator tooling として扱えます。

`artifact` と `runtime-agent` は operator extension / internal execution surface
を扱う grouped command です。install / deploy / rollback lifecycle の public
command には含めません。

## 設定カスケード {#config-cascade}

1. command flag (`--remote`, `--token`)
2. env (`TAKOSUMI_REMOTE_URL`, `TAKOSUMI_INSTALLER_TOKEN`,
   `TAKOSUMI_AGENT_TOKEN`)
3. config file
4. built-in default

config file は remote URL / token の locator です。Space routing や operator
policy は operator config / install context で扱います。
