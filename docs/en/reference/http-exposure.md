# HTTP Exposure {#http-exposure}

Public app endpoints are modeled as normal component connections. A workload publishes callable HTTP output, and an ingress component such as `gateway` listens to that output and connects it to the gateway kind's listener and route configuration.

`listeners` and `routes` are part of the adopted gateway kind definition's `spec` schema. They are not manifest root fields. Operator and provider capability decide which listener, TLS, host, and route features are supported. Unsupported features are rejected before resource creation.

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
          host: app.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

`web.http` is workload upstream output and usually contains `targets[]`. `public.public` is gateway or ingress public endpoint output and usually contains `endpoints[]`. Both use the `http-endpoint` contract, but the publisher role is different. `routes[].to` points to a `listen` key; in this example the key is `app`.

## Portable Route Semantics {#portable-route-semantics}

The normative portable route semantics live in the [Kind Catalog](./type-catalog.md#gateway-portable-subset). Gateway deployment output is non-secret `http-endpoint` output data with `endpoints[]`. Each endpoint records `url`, `scheme`, `host`, `listener`, `visibility`, `primary`, and optional `routes[]`.

When multiple public endpoints are produced, exactly one endpoint is primary. Unsupported listener, TLS policy, host, or path prefix settings are rejected before resource creation.

## Request Path {#request-path}

Install and deploy are separate from runtime request handling.

```text
install / deploy:
  manifest -> Installer API -> Deployment record / outputs
          -> selected provider/operator configuration

runtime request:
  client -> provider-native listener/route -> active workload
         <- same provider data plane <- response
```

Takosumi records manifest validation, publish/listen resolution, Deployment outputs, and Deployment record. The selected provider or operator configuration uses that record to create provider-native ingress. Runtime HTTP requests do not pass through the Installer API.

Runtime traffic authority is the `succeeded` Deployment pointed to by `Installation.currentDeploymentId` plus the ingress Deployment record linked to that Deployment. `running` and `failed` Deployments are history, not HTTP traffic authority. Rollback moves the pointer back to a previous succeeded Deployment and reuses that Deployment's public/non-secret outputs and reactivation record.

## Domain Policy {#domain-policy}

`spec.listeners.<name>.host` is gateway-specific ingress input defined by that kind. If `host` is omitted, the adopted kind definition and operator policy define the meaning. An operator-assigned default public host can appear in the produced public endpoint output.

Domain reservation, custom-domain proof, DNS ownership proof, and TLS provisioning belong to the adopted kind definition, operator policy, and provider flow. The manifest does not carry provider object ids, DNS verification records, TLS certificate handles, or generated object references.

## Related Pages {#related-pages}

- [Manifest](./manifest.md)
- [Kind Catalog](./type-catalog.md)
