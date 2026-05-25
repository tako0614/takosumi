# クイックスタート — ローカル記録の検証 {#quickstart}

## 前提条件

- [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.x 以上

この手順は local dev サーバーに Manifest を渡し、Installation と最初の Deployment の記録を作るところまでを確認します。

## 1. CLI を入れる

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

Takosumi はサーバーと CLI (クライアント) が分かれています。開発時はサーバーをバックグラウンドで起動し、別の shell で CLI を使います。

別 shell でサーバーを起動する:

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

`TAKOSUMI_INSTALLER_TOKEN` は API の認証トークンです。開発用の固定値 `dev-installer-token` を使います。

元の shell に戻って環境変数を設定:

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

成功すると `changes[]` (予定差分) と `expected.manifestDigest` (dry-run 時のハッシュ照合値) が返ります。

```json
{
  "manifestDigest": "sha256:...",
  "changes": [{ "op": "create", "component": "web", "kind": "worker" }],
  "expected": { "manifestDigest": "sha256:..." }
}
```

`changes` は作成される component のリスト、`manifestDigest` はソースの識別子です。 apply 時にこの digest を照合して、dry-run 後にソースが変わっていないことを確認します。

## 5. Installation を作る

```bash
takosumi install --space space_personal --source "$APP_ROOT"
```

dry-run の digest に固定して apply する場合:

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

ここまでが local ledger quickstart の runnable path です。public app endpoint は gateway / ingress provider がある operator 環境でだけ作られます。

次のステップ: [component 接続と HTTP 公開](./next-steps.md)

→ [Manifest リファレンス](../reference/manifest.md)
