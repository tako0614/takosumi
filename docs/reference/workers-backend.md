# Workers backend implementation note

Cloudflare Workers / D1 / R2 / Queues / Durable Objects / wrangler.toml と、必要な image-backed workload 用の optional Cloudflare Containers は Takosumi reference 実装の execution detail です。Cloudflare Containers は Worker-first control path の前提ではなく、native kind binding が image-backed workload を必要とする場合の substrate です。

Public 用語は manifest / Installation / Deployment を優先します。Runtime observation (code: `ProviderObservation`) / RoutingPointer / runtime target metadata は reference implementation の内部 evidence です。これらは Cloudflare 以外の compute substrate (Kubernetes / bare metal / 自前 runtime) に展開するための backend-neutral implementation vocabulary であり、manifest authoring contract ではありません。

Cloudflare native kind packages live in `takosumi-plugins` and publish under `@takos/takosumi-kind-cloudflare-*`. They, together with the runtime-agent Cloudflare connector and operator-owned `wrangler.toml` wiring, materialize the reference kernel terms into Cloudflare primitives such as Worker, Route, Durable Object, R2, D1, Queues, and Hyperdrive.

Cloudflare route / Worker が request-time data plane になり、Takosumi API process はその request を毎回 proxy しません。他 substrate (K8s + Gateway / Ingress + cert-manager + Postgres、 bare metal + Caddy / Nginx + systemd) も同等の native kind binding を持てば Takosumi の契約は変わりません。

## 関連

- [kernel.md](./architecture/kernel.md) — Takosumi が manifest からどう Deployment / runtime observation を作るか
- [runtime-routing.md](./architecture/runtime-routing.md) — runtime routing の materialization 形態
- [control-plane.md](./architecture/control-plane.md) — control plane が Cloudflare primitive にどう map するか
