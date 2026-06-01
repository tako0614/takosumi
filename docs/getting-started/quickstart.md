# クイックスタート — ローカル記録の検証 {#quickstart}

## 前提条件

- Node.js 20+ / npm または Bun

この手順では、ローカル Takosumi server に source を渡し、Installation と最初の Deployment が作られるところまでを確認します。
public URL で提供するには、gateway や runtime を持つ operator 環境が必要です。

## 1. CLI をインストールする

```bash
npm install -g @takosjp/takosumi
takosumi version
```

## 2. source root を作る

```bash
mkdir hello-takosumi && cd hello-takosumi
printf '{"name":"hello-takosumi","version":"0.1.0"}\n' > package.json
```

`package.json` は Takosumi 専用 metadata ではなく、repo の汎用 metadata です。

## 3. ローカル server を起動する

別 shell で起動します。

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

元の shell で接続先を設定します。

```bash
export APP_ROOT="$PWD"
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
```

## 4. dry-run する

```bash
takosumi install dry-run --space space_personal --source "$APP_ROOT"
```

成功すると `installPlan`、`planSnapshotDigest`、`changes[]`、`expected` が返ります。

```json
{
  "source": { "kind": "local", "url": "/path/to/hello-takosumi" },
  "planSnapshotDigest": "sha256:...",
  "installPlan": {
    "repo": { "id": "hello-takosumi", "name": "hello-takosumi", "version": "0.1.0" },
    "requestedBindings": [],
    "resolvedBindings": [],
    "publications": [],
    "changes": []
  },
  "expected": { "planSnapshotDigest": "sha256:..." }
}
```

## 5. Installation を作る

```bash
takosumi install --space space_personal --source "$APP_ROOT"
```

dry-run で得た digest を指定して apply するには:

```bash
takosumi install --space space_personal --source "$APP_ROOT" \
  --expected-plan-snapshot-digest sha256:<copied-from-dry-run>
```

成功すると Installation id と Deployment id が返ります。

```json
{
  "installation": { "id": "inst_...", "status": "ready" },
  "deployment": { "id": "dep_...", "status": "succeeded" }
}
```

## 次に読む

- [Installer API](../reference/installer-api.md)
- [CLI](../reference/cli.md)
- [プラットフォームサービス](../reference/platform-services.md)
