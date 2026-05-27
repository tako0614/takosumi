# HTTP Exposure {#http-exposure}

HTTP exposure is a component graph. A workload has an HTTP output, and a
gateway or ingress component connects to that output and exposes it through
listener and route configuration. Browser reachability is defined by the
gateway kind's `spec`; root `publish` is not required for reachability.

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

`listeners` and `routes` are part of the gateway kind's `spec` schema.
`routes[].to` points to a `connect` binding key. In this example the key is
`app` and the injection mode is `upstream`.

Root `publish` is an optional declaration for recording the gateway output as
an Installation output service path declaration in Deployment outputs.
HTTP listeners, hosts, TLS, and route rules are handled by the gateway or
ingress kind's `spec`.

Add root `publish` only when an operator or product distribution should be able
to project the public endpoint into a Space-visible platform service inventory:

```yaml
publish:
  public-endpoint:
    output: public.public
    path: acme.web.public
```

## Request Path {#request-path}

Install and deploy are separate from runtime request handling.

```text
install / deploy:
  manifest -> Installer API -> Deployment record / outputs
          -> selected backend/operator binding

runtime request:
  client -> backend-native listener/route -> active workload
         <- same backend data plane <- response
```

Takosumi records manifest validation, connection resolution, Deployment outputs,
and Deployment record during deploy. The selected backend or operator binding
creates backend-native ingress config. Runtime HTTP requests are delivered by
the backend-native listener or route to the active workload.

Runtime traffic authority is the `succeeded` Deployment pointed to by
`Installation.currentDeploymentId`. `running` and `failed` Deployments are
history. Rollback moves the current pointer back to a previous succeeded
Deployment.

## Domain Policy {#domain-policy}

`spec.listeners.<name>.host` is gateway-specific ingress input. Default host
assignment, custom-domain proof, DNS ownership proof, and TLS provisioning are
handled by the adopted gateway kind, operator policy, and backend-specific
flow. The manifest does not carry backend object ids, DNS verification records,
TLS certificate handles, or generated object references.

## Related Pages {#related-pages}

- [Manifest](./manifest.md)
- [Official Type Catalog](./type-catalog.md)
