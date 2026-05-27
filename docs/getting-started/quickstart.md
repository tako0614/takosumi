# クイックスタート — ローカル記録の検証 {#quickstart}

## 前提条件

- [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.x 以上

この手順では、ローカル開発サーバーに manifest を渡して Installation と最初の Deployment の記録が作られるところまでを確認します。アプリを公開 URL で提供するには、gateway を備えた operator 環境が必要です。

## 1. CLI をインストールする

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

## 2. ソースルートを作る

```bash
mkdir hello-takosumi && cd hello-takosumi
mkdir -p src
```

`src/worker.ts`

```ts
export default {
  fetch() {
    return new Response("hello from takosumi");
  },
};
```

`.takosumi.yml`

```yaml
apiVersion: v1
metadata:
  id: com.example.hello
  name: Hello Takosumi
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

## 3. ローカル開発サーバーを起動する

Takosumi はサーバーと CLI (クライアント) が分かれています。まずサーバーを 1 つの shell で起動し、CLI の操作は別の shell で行います。

サーバー用の shell で以下を実行します:

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

`TAKOSUMI_INSTALLER_TOKEN` は API の認証トークンです。ローカル開発ではこの固定値を使います。

元の shell に戻り、環境変数を設定します:

```bash
cd /path/to/hello-takosumi
export APP_ROOT="$PWD"
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
```

## 4. dry-run する

```bash
takosumi install dry-run --space space_personal --source "$APP_ROOT"
```

成功すると、`changes[]` (予定差分) と `expected.manifestDigest` (ソースの識別子) が返されます。

```json
{
  "manifestDigest": "sha256:...",
  "changes": [{ "op": "create", "component": "web", "kind": "worker" }],
  "expected": { "manifestDigest": "sha256:..." }
}
```

`changes` は作成される component のリストです。apply 時に `manifestDigest` を照合し、dry-run 後にソースが変わっていないことを確認します。

## 5. Installation を作る

```bash
takosumi install --space space_personal --source "$APP_ROOT"
```

dry-run で得た digest を指定して apply するには:

```bash
takosumi install --space space_personal --source "$APP_ROOT" \
  --expected-manifest-digest sha256:<copied-from-dry-run>
```

成功すると Installation id と Deployment id が返ります。

```json
{
  "installation": { "id": "inst_...", "status": "ready" },
  "deployment": { "id": "dep_...", "status": "succeeded" }
}
```

ここまでがローカル環境でのクイックスタートの範囲です。

次のステップ: [component 接続と HTTP 公開](./next-steps.md)

→ [Manifest リファレンス](../reference/manifest.md)
