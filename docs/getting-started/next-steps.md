# 次のステップ — component 接続と HTTP 公開 {#next-steps}

[クイックスタート](./quickstart.md) で Installation を作ったあとの追加手順です。

## component を接続する {#connect-components}

最初の install が通ったあと、DB などの component を追加して接続できます。

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

この Manifest をデプロイすると、web の worker プロセスに以下の環境変数が自動で渡されます:

```
DB_HOST=<postgres の接続先>
DB_PORT=5432
DB_USER=<自動生成されたユーザー名>
DB_PASSWORD=<自動生成されたパスワード>
```

worker のコードでは `Deno.env.get("DB_HOST")` のように通常の環境変数として使えます。

保存したら既存 Installation に apply します:

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

## runtime HTTP 公開を追加する {#add-http-exposure}

web component が HTTP endpoint を publish し、gateway がそれを listen して
public URL として公開します:

```
web (publish http) --> gateway (listen) --> https://your-app.example.com
```

operator が `gateway` を提供している環境で、manifest に以下を追加します。
HTTP 公開の詳しい仕様は [HTTP 公開](../reference/http-exposure.md) を参照してください。

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

`host` を省略すると operator が自動でホスト名を割り当てます。
ローカル開発環境では `host: hello.takosumi.test` のように明示することもできます。

保存したら同じ Installation に apply します:

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

## 更新と rollback を試す {#update-and-roll-back}

Manifest や `src/worker.ts` を変更したら、既存 Installation に次の Deployment を
apply します。

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

前の Deployment に戻す場合は retained Deployment id を指定します。rollback は
新しい Deployment を作らず、current pointer を過去の `succeeded` Deployment に
戻します。

```bash
takosumi rollback inst_... dep_...
```

→ [Manifest リファレンス](../reference/manifest.md)
