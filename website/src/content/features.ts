export interface Feature {
  readonly title: string;
  readonly body: string;
}

export const FEATURES: readonly Feature[] = [
  {
    title: "Manifest-driven",
    body:
      "web-service@v1 / database-postgres@v1 / object-store@v1 / custom-domain@v1 / worker@v1 等の portable shape を YAML/JSON-LD 互換 manifest で宣言、 takosumi deploy で apply。",
  },
  {
    title: "Multi-cloud + selfhost",
    body:
      "20 default + 1 opt-in provider plugin で AWS / GCP / Cloudflare / Azure / Kubernetes / Deno Deploy / docker-compose / systemd / filesystem を同一 spec で deploy。",
  },
  {
    title: "Self-hostable, JSR-distributed",
    body:
      "kernel と runtime-agent は JSR で配布。 Deno 1 process で takosumi server を起動するだけで control plane + agent が立ち上がる。",
  },
  {
    title: "Plugin / agent 分離",
    body:
      "kernel は cloud SDK を直接呼ばない。 runtime-agent が SigV4 / OAuth / kubectl / docker を握り、 credential は agent 側にだけ存在する。",
  },
  {
    title: "Artifact upload",
    body:
      "OCI image だけでなく js-bundle / lambda-zip / static-bundle / wasm を content-addressed で push、 manifest から hash で参照。",
  },
  {
    title: "Operator-friendly",
    body:
      "~/.takosumi/config.yml、 shell completion、 takosumi server --detach で systemd / docker template 出力。",
  },
];
