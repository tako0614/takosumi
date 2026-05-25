# Workers backend implementation note

Cloudflare Workers / D1 / R2 / Queues / Durable Objects / wrangler.toml と、
必要な image-backed workload 用の optional Cloudflare Containers は Takosumi の
reference execution detail です。Cloudflare Containers は Worker-first control
path の前提ではなく、provider adapter が image-backed workload を
必要とする場合の substrate です。

Public 用語は AppSpec / Installation / Deployment
を優先します。ProviderObservation / GroupHead / runtime target metadata は
reference implementation の内部 evidence です。これらは Cloudflare 以外の
compute substrate (Kubernetes / bare metal / 自前 runtime) に展開するための
provider-neutral implementation vocabulary であり、AppSpec authoring contract
ではありません。

Cloudflare provider adapters live in `@takos/takosumi-cloudflare-providers`.
They, together with the runtime-agent Cloudflare connector and operator-owned
`wrangler.toml` wiring, materialize the reference kernel terms into Cloudflare
primitives (Worker, Route, Durable Object, R2, D1, Queues, Hyperdrive 等).
`@takos/takosumi-plugins` is used for official catalog helpers and reference
aliases; it is not the Cloudflare materialization package.

Cloudflare route / Worker が request-time data plane になり、Takosumi kernel API
process はその request を毎回 proxy しません。他 substrate (K8s + Gateway /
Ingress + cert-manager + Postgres、 bare metal + Caddy / Nginx + systemd)
も同等の provider adapter を持てば kernel 契約は変わりません。

## 関連

- [kernel.md](./architecture/kernel.md) — kernel が AppSpec からどう Deployment
  / ProviderObservation を作るか
- [runtime-routing.md](./architecture/runtime-routing.md) — runtime routing の
  materialization 形態
- [control-plane.md](./architecture/control-plane.md) — control plane が
  Cloudflare primitive にどう map するか
