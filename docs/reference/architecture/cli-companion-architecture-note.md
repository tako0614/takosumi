# CLI Surface アーキテクチャ {#cli-surface-architecture}

`takosumi` CLI は Installer API と operator 参照 API の thin client。 authority は Takosumi と operator の設定側にあり、CLI は manifest source と command intent を運ぶだけである。

## 権限境界 {#authority-boundary}

- public source of truth は `.takosumi.yml` (= manifest)。
- CLI は provider selection���Space entitlement、risk evaluation、quota decision を自前で確定しない。
- Space / actor の��決は installer token issuer と Takosumi context の責務。
- CLI は manifest source を Installer API に渡し、response を表示する。

## モード {#modes}

- **remote**: `--remote` / `TAKOSUMI_REMOTE_URL` / config で Takosumi URL が resolve された場合。`TAKOSUMI_INSTALLER_TOKEN` を installer bearer として使う。
- **local**: remote URL が無い場合の authoring / test fixture 用。永続 state や multi-actor auth を前提にする command は local で提供しない。

`takosumi server` は local Takosumi host を起動し、その後の CLI invocation は `http://localhost:<port>` に対する remote mode と同じ扱いになる。

## コマンド surface {#command-surface}

current public lifecycle command は [Installer API](../installer-api.md) に対応する。

- `install`
- `install dry-run`
- `deploy`
- `deploy dry-run`
- `rollback`

Installation / Deployment ledger reads use the operator 参照 API. They are not additional write lifecycle endpoints. reference Takosumi では internal control-plane route を使う operator tooling として扱えます。

`artifact` と `runtime-agent` は operator extension / internal execution surface を扱う grouped command です。install / deploy / rollback lifecycle の public command には含めません。

## 設定カスケード {#config-cascade}

1. command flag (`--remote`, `--token`)
2. env (`TAKOSUMI_REMOTE_URL`, `TAKOSUMI_INSTALLER_TOKEN`, `TAKOSUMI_AGENT_TOKEN`)
3. config file
4. built-in default

config file は remote URL / token の locator です。Space routing や operator policy は operator config / install context で扱います。
