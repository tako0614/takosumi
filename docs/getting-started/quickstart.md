# Quickstart — first install まで {#quickstart}

このページでは local dev kernel を起動し、`.takosumi.yml` を送って最初の
Installation / Deployment を作ります。

ここでの成功条件は、local kernel が AppSpec を受け取り、Installation を作り、
最初の Deployment を `deployment.status: "succeeded"` として記録することです。
dry-run では apply 前の source 差し替えを防ぐ `expected.manifestDigest` などの
digest guard も確認します。

## 1. CLI を入れる

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

## 2. source root を作る

任意の空 directory で作業します。

```bash
mkdir hello-takosumi
cd hello-takosumi
mkdir -p dist
```

worker kind は source 内の file path を `spec.entrypoint` から読みます。まず
Quickstart 用の最小 worker file を置きます。

```bash
cat > dist/worker.mjs <<'EOF'
export default {
  fetch() {
    return new Response("hello from takosumi");
  },
};
EOF
```

次に AppSpec を置きます。AppSpec root は `apiVersion`、`metadata`、`components`
の 3 field です。

```bash
cat > .takosumi.yml <<'EOF'
apiVersion: v1
metadata:
  id: com.example.hello
  name: hello
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
EOF
```

`kind: worker` は takosumi.com reference kind descriptor example の short alias
です。operator が alias を kind URI に解決し、対応する実行先を選びます。
`entrypoint` は source snapshot 内で worker implementation が読む path です。

## 3. local dev kernel を起動する

installer command は kernel URL に対して HTTP request を送る thin client です。
local で試す場合も、別 shell で `takosumi server` を起動して `--remote` で接続
します。

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

`TAKOSUMI_DEV_MODE=1` は dev 専用です。plaintext secret storage や unsafe
default を許可します。production / staging では使いません。quickstart の local
server には tutorial で使う reference `worker` alias が含まれます。managed
operator は自分が support する alias と実行先を選びます。

以降の command は別 shell から同じ `hello-takosumi` directory で実行します。

```bash
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
```

## 4. dry-run する

dry-run は Installation を作らず、AppSpec と source を検証して
`expected.manifestDigest` などの digest guard を返します。

```bash
takosumi install dry-run --space space:personal --source .
```

成功すると JSON が返ります。まず見る field は次です。

```json
{
  "source": { "kind": "local", "url": "." },
  "manifestDigest": "sha256:...",
  "changes": [
    { "op": "create", "component": "web", "kind": "worker" }
  ],
  "expected": {
    "manifestDigest": "sha256:..."
  }
}
```

`--source .` は dev / operator-local source です。kernel から同じ path を読める
構成だけで使います。remote operator に送る場合は `git:` source または build
service が作る `prepared:` source を使います。

## 5. Installation を作る

dry-run が通ったら apply します。

```bash
EXPECTED_MANIFEST_DIGEST=<expected.manifestDigest from dry-run response>
takosumi install --space space:personal --source . \
  --expected-manifest-digest "$EXPECTED_MANIFEST_DIGEST"
```

`expected` は dry-run で見た入力と apply 時の入力がずれていないことを確認する
guard です。quickstart の `local` source では `.takosumi.yml` bytes を守る
`expected.manifestDigest` を渡します。`local` は source tree 全体の byte drift
までは守らない dev/operator-local mode です。`git` source では
`--expected-commit`、`prepared` source では `--expected-source-digest` も併用
します。

成功すると Installation と最初の Deployment が返ります。

```json
{
  "installation": {
    "id": "installation:...",
    "spaceId": "space:personal",
    "status": "running"
  },
  "deployment": {
    "id": "deployment:...",
    "status": "succeeded",
    "manifestDigest": "sha256:..."
  }
}
```

この時点で、Takosumi は AppSpec を Space に Installation として記録し、最初の
apply 結果を Deployment として保存しています。

## 6. component を接続する

component 間の依存は `publish` と `listen` で書きます。

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
    spec:
      entrypoint: dist/worker.mjs
```

`db` が `db.connection` を publish し、`web` が `listen.db.from` で参照します。
material を env / mount / upstream のどれで注入するかは `listen`
側で明示します。

## 次に読む

- [読む順序](./reading-paths.md)
- [コンセプト](./concepts.md)
- [AppSpec リファレンス](../reference/app-spec.md)
- [Build service handoff](../reference/build-spec.md)
- [Provider Implementations](../reference/providers.md)
