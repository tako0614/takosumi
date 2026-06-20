export interface Pillar {
  readonly title: string;
  readonly body: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: "入口は共通、実体は外部",
    body: "API、DB、object store、worker は既存 provider の先で作る。Takosumi は Capsule / Run を記録し、credential は ProviderConnection と CredentialRecipe から run phase ごとに解決する。",
  },
  {
    title: "cloud でも VM でも同じ形",
    body: "OSS は AWS、GCP、Cloudflare、Hetzner などの既存 provider をそのまま使う。Takosumi Cloud だけが Cloud 専用の compatibility gateway と managed resources を追加する。",
  },
  {
    title: "lock-in しない、引っ越せる、終わらない",
    body: "同じ module に別の ProviderBinding を渡せる。dev / prod / 別 cloud に移しても、Capsule、Run、StateVersion、Output の扱いは変わらない。",
  },
];
