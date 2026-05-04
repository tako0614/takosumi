# Routing Model

Takosumi に route 層は既にある。ただし「route」という語が複数の層で使われる
ため、設計上は明確に分ける必要がある。

## Route Layers

| Layer                       | Example / type                                      | Meaning                                      |
| --------------------------- | --------------------------------------------------- | -------------------------------------------- |
| HTTP API route layer        | `/v1/deployments`, `/api/public/v1/*`               | kernel 自身の API endpoint                   |
| Manifest authoring route    | `PublicRouteSpec`, `AppSpecRoute`                   | user が app への ingress / listener を宣言   |
| Core Deployment route       | `DeploymentRoute`, `DeploymentRouteAssignment`      | resolved desired state 内の canonical route  |
| Routing projection layer    | `RouteProjection`, `RouteOwnershipRecord`           | runtime route binding を addressable に投影  |
| Service endpoint layer      | `ServiceEndpoint`, `ServiceTrustRecord`, `Grant`    | service discovery / trust / access grant     |
| Provider materialized route | ALB listener, Cloudflare route, URL map, CoreDNS 等 | provider が実際に作る cloud / network object |

この分離により、custom domain、HTTP path、TCP listener、service discovery、
internal RPC endpoint を 1 つの曖昧な route object に押し込まない。

## Manifest Route

`.takos/app.yml` 相当の public manifest には `routes` がある。

```ts
interface PublicRouteSpec {
  id?: string;
  target?: string;
  host?: string;
  path?: string;
  protocol?: string;
  port?: number;
  methods?: string[];
  source?: string;
}
```

compiler はこれを `AppSpecRoute` へ正規化する。

```ts
interface AppSpecRoute {
  name: string;
  to: string;
  host?: string;
  path?: string;
  protocol: string;
  port?: number;
  targetPort?: number;
  methods?: string[];
  source?: string;
  interfaceContractRef?: string;
  raw: PublicRouteSpec;
}
```

manifest route は authoring intent である。provider object でも canonical
runtime assignment でもない。

source:

- `packages/kernel/src/domains/deploy/types.ts`
- `packages/kernel/src/domains/deploy/compiler.ts`

## Deployment Route

Deployment desired state では route は `DeploymentRoute` になる。

```ts
interface DeploymentRoute {
  id: string;
  exposureAddress: ObjectAddress;
  routeDescriptorId: DescriptorId;
  match: Record<string, unknown>;
  transport?: { security?: string; tls?: Record<string, unknown> };
}
```

route がどの component へ traffic を送るかは `DeploymentActivationEnvelope` の
`route_assignments` に入る。

```ts
interface DeploymentRouteAssignment {
  routeId: string;
  protocol?: string;
  assignments: readonly {
    componentAddress: ObjectAddress;
    weightPermille: number;
    labels?: Record<string, string>;
  }[];
}
```

これにより、route match と traffic assignment を分離できる。canary / blue-green
では route 自体を作り直さず、assignment weight と labels を更新できる。

source:

- `packages/contract/src/core-v1.ts`
- `packages/kernel/src/domains/deploy/deployment_service.ts`

## Routing Projection

runtime route binding を addressable route set へ投影する domain がある。

```ts
interface RouteProjection {
  id: RouteProjectionId;
  spaceId: string;
  groupId: string;
  activationId: string;
  desiredStateId?: string;
  projectedAt: string;
  routes: readonly ProjectedRoute[];
}
```

`RouteOwnershipRecord` は host / path / port / source / protocol の owner を保持
し、`reserved` / `active` / `released` / `conflict` を表す。

この層の役割は「runtime に投影された route を誰が所有しているか」を扱うこと
であり、manifest compile や provider apply そのものではない。

source:

- `packages/kernel/src/domains/routing/types.ts`
- `packages/kernel/src/domains/routing/projection.ts`
- `packages/kernel/src/domains/routing/stores.ts`

## Service Endpoint

service endpoint domain は route よりも service discovery / trust / grant
に近い。

```ts
interface ServiceEndpoint {
  id: ServiceEndpointId;
  serviceId: ServiceId;
  spaceId: SpaceId;
  groupId: GroupId;
  name: string;
  protocol: "http" | "https" | "tcp" | "udp";
  url?: string;
  host?: string;
  port?: number;
  pathPrefix?: string;
  health: ServiceEndpointHealth;
}
```

この層には `ServiceTrustRecord` と `ServiceGrant` がある。route で公開すること
と service trust は別の問題である。

source:

- `packages/kernel/src/domains/service-endpoints/types.ts`
- `packages/kernel/src/domains/service-endpoints/registry.ts`

## Custom Domain

`custom-domain@v1` は canonical route そのものではない。DNS / TLS / ownership
verification を materialize する resource contract として扱う。

route が必要とする `host` と、provider が作る DNS record / TLS certificate /
domain verification object は関連するが同一ではない。これを分けることで、
Cloudflare DNS + AWS ALB、Route53 + Cloudflare Worker、CoreDNS + systemd など
の組み合わせを自然に扱える。

## Design Decision

Takosumi の canonical route は `Deployment.desired.routes` と
`Deployment.desired.activation_envelope.route_assignments` である。manifest
route は input、routing projection は runtime への投影、service endpoint は
discovery と trust、provider route は materialized object として扱う。
