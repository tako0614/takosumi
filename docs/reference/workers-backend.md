# Workers backend implementation note

Cloudflare Workers / Cloudflare Containers / wrangler.toml は Takosumi の
reference materialization detail です。

Core 用語は Resource / Deployment / ProviderObservation / GroupHead /
RuntimeBinding を優先します。これらは provider substrate
に依存しない抽象であり、Cloudflare 以外の compute substrate (Kubernetes / bare
metal / 自前 runtime) に substitutability を保ったまま展開できます。

`@takos/takosumi-plugins` の Cloudflare connector / `wrangler.toml` テンプレート
/ `@takos/takosumi-runtime-agent` の Cloudflare gateway は、これら kernel 用語を
Cloudflare の primitive (Worker、 Durable Object、 R2、 D1、 Queues、 Hyperdrive
等) に materialize する具体例の一つです。他 substrate (K8s + cert-manager +
Postgres、 bare metal + systemd) も同等の materializer を持てば kernel
契約は変わりません。

## 関連

- [kernel.md](./architecture/kernel.md) — kernel が Shape manifest からどう
  Deployment / ProviderObservation を作るか
- [tenant-runtime.md](./architecture/tenant-runtime.md) — tenant runtime の
  materialization 形態
- [control-plane.md](./architecture/control-plane.md) — control plane が
  Cloudflare primitive にどう map するか
