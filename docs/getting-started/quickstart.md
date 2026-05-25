# クイックスタート — ローカル ledger 検証 {#quickstart}

## 前提条件

- [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.x 以上

この手順は local dev kernel に AppSpec を渡し、Installation と最初の Deployment
record を作るところまでを確認します。

## 確認できること

完了すると Installation id と Deployment id が返ります。この最小 path では
AppSpec validation と Deployment ledger を確認します。public app endpoint は
gateway / ingress provider がある operator 環境でだけ作られます。

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
export APP_ROOT="$PWD"
mkdir -p src

cat > src/worker.ts <<'EOF'
export default {
  fetch() {
    return new Response("hello from takosumi");
  },
};
EOF

cat > .takosumi.yml <<'EOF'
apiVersion: v1
metadata:
  id: com.example.hello
  name: Hello Takosumi
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
EOF
```

stock local server は AppSpec を検証し、Installation / Deployment metadata を
記録します。runtime resource を provision する operator-backed runtime では、
[Operator Bootstrap](../operator/bootstrap.md) で kind alias と provider binding
を渡した server を起動します。

## 3. local dev kernel を起動する

local kernel は 5 endpoint Installer API を受け、AppSpec を検証し、Installation
と最初の Deployment record を作る dev 用 process です。production では operator
account plane が token、Space、provider binding を用意します。

別 shell で kernel を起動する:

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

`TAKOSUMI_DEV_MODE` は dev 専用。production では unset する。

別 shell で:

```bash
cd /path/to/hello-takosumi
export APP_ROOT="$PWD"
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
```

`http://localhost` は single-host loopback dev 専用です。public / LAN dev
hostname で動かすときは local-substrate の HTTPS hostname を使います。

`--source` は kernel process から見える path として解釈されます。local
quickstart では source root の absolute path を `APP_ROOT` に入れて使います。

## 4. dry-run する

dry-run は apply せず検証だけ行い、digest guard を返す。

```bash
takosumi install dry-run --space space_personal --source "$APP_ROOT"
```

成功時の応答:

```json
{
  "source": { "kind": "local", "url": "/absolute/path/to/hello-takosumi" },
  "manifestDigest": "sha256:...",
  "appSpec": {
    "apiVersion": "v1",
    "metadata": {
      "id": "com.example.hello",
      "name": "Hello Takosumi"
    },
    "components": {
      "web": {
        "kind": "worker",
        "spec": { "entrypoint": "src/worker.ts" }
      }
    }
  },
  "changes": [
    { "op": "create", "component": "web", "kind": "worker" }
  ],
  "expected": {
    "manifestDigest": "sha256:..."
  }
}
```

見るべき場所は `changes[]` と `expected` です。`changes[]` は apply したときの
予定差分、`manifestDigest` は読まれた AppSpec の digest、`expected` は次の apply
に渡せる drift guard です。

## 5. Installation を作る

dry-run が通ったら apply する。

```bash
takosumi install --space space_personal --source "$APP_ROOT"
```

review した dry-run result に固定して apply したい場合は、dry-run 出力の
`expected.manifestDigest` を `--expected-manifest-digest` に渡す。

```bash
takosumi install --space space_personal --source "$APP_ROOT" \
  --expected-manifest-digest sha256:<copied-from-dry-run>
```

成功時の応答:

```json
{
  "installation": {
    "id": "inst_...",
    "spaceId": "space_personal",
    "status": "ready"
  },
  "deployment": {
    "id": "dep_...",
    "status": "succeeded",
    "manifestDigest": "sha256:..."
  }
}
```

この local ledger quickstart の最小例は worker component を Deployment record
として作るところまでを確認します。公開URLは operator の gateway / ingress
provider がある場合にだけ作られます。

ここまでが local ledger quickstart の runnable path です。以降は provider
binding を持つ operator-backed runtime で試す例です。

## Optional: component を接続する

この例は operator profile が `worker` と `postgres` aliases を kind URI に map
している前提です。最初の install が通ったあと、必要になった component を
`publish` / `listen` で接続します。

```yaml
apiVersion: v1
metadata:
  id: com.example.hello
  name: Hello Takosumi
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
        as: secret-env
        prefix: DB
    spec:
      entrypoint: src/worker.ts
```

保存したら既存 Installation に apply します:

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

## Optional: runtime HTTP exposure を追加する

public app endpoint まで試す場合は、operator が official `gateway` descriptor
を採用し、`gateway` alias、domain policy、provider binding を提供している環境
で、AppSpec の `components:` を次の形にします:

`routes` は `gateway` descriptor の `spec` 内にある catalog-owned schema
です。AppSpec core field ではありません。

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    publish:
      http:
        as: http-endpoint

  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

保存したら同じ Installation に apply します:

`host` を省略した listener は operator-assigned public host を要求します。
local-substrate で `.test` hostname を使う operator profile なら、ここに
`host: hello.takosumi.test` のような profile-owned host を指定できます。

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

## 更新と rollback を試す

AppSpec や `src/worker.ts` を変更したら、既存 Installation に次の Deployment を
apply します。

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

`source.kind: "local"` では `expected.manifestDigest` は `.takosumi.yml` bytes
だけを guard します。`src/worker.ts` など runtime file まで review/apply を
byte-stable に固定したい場合は、git source か build service の prepared source
snapshot を使います。

前の Deployment に戻す場合は retained Deployment id を指定します。rollback は
新しい Deployment を作らず、current pointer を過去の `succeeded` Deployment に
戻します。

```bash
takosumi rollback inst_... dep_...
```

→ [AppSpec リファレンス](../reference/app-spec.md)
