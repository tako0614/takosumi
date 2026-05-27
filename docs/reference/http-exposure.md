# HTTP 公開 {#http-exposure}

HTTP 公開は component graph で表します。workload は HTTP output を持ち、gateway / ingress component がその output を `connect` して listener / route 設定で公開します。browser から到達できるかどうかは gateway kind の `spec` が決めます。root `publish` は reachability には不要です。

```yaml
apiVersion: v1
metadata:
  id: com.example.web
  name: Example Web
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts

  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
    spec:
      listeners:
        public:
          protocol: https
          host: app.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

`listeners` と `routes` は gateway kind の `spec` schema です。`routes[].to` は `connect` binding key を指します。この例では key は `app`、injection mode は `upstream` です。

root `publish` は、gateway が作った output を Deployment output の Installation output service path declaration として記録するための任意の宣言です。HTTP listener、host、TLS、route rule は gateway / ingress kind の `spec` が扱います。

operator / product distribution が公開 endpoint を Space-visible platform service inventory に投影して discoverable にする場合だけ、root `publish` を追加します。

```yaml
publish:
  public-endpoint:
    output: public.public
    path: acme.web.public
```

## Request Path

install / deploy と runtime request は別の plane です。

```text
install / deploy:
  manifest -> Installer API -> Deployment record / outputs
          -> selected backend/operator binding

runtime request:
  client -> backend-native listener/route -> active workload
         <- same backend data plane <- response
```

Takosumi は deploy 時に manifest validation、connection resolution、Deployment outputs、Deployment record を残します。選択された backend / operator binding が backend-native ingress config を実体化します。runtime HTTP request は backend-native listener / route が active workload に届けます。

runtime traffic authority は `Installation.currentDeploymentId` が指す `succeeded` Deployment です。`running` / `failed` Deployment は history です。rollback は current pointer を過去の `succeeded` Deployment に戻します。

## Domain Policy

`spec.listeners.<name>.host` は gateway kind の ingress input です。default host、custom-domain proof、DNS ownership proof、TLS provisioning は採用した gateway kind、operator policy、backend-specific flow が扱います。manifest は backend object ID、DNS verification record、TLS certificate handle、generated object ref を直接書きません。

## 関連ページ

- [manifest](./manifest.md)
- [Takosumi 公式型カタログ仕様](./type-catalog.md)
