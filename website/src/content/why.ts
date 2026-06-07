export interface Pillar {
  readonly title: string;
  readonly body: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: "入口は共通、実体は外部",
    body:
      "API、DB、object store、gateway は provider adapter の先で作る。Takosumi は Installation / Deployment を記録し、credential は operator の実行環境に置く。",
  },
  {
    title: "cloud でも VM でも同じ形",
    body:
      "Cloudflare、AWS、GCP、Kubernetes、Docker Compose、systemd を operator-owned adapter model で扱う。Source と Deployment ledger は同じまま。",
  },
  {
    title: "lock-in しない、引っ越せる、終わらない",
    body:
      "operator が実行先を差し替えても、Installation / Run の入口は変わらない。cloud、VM、cluster のどれかに閉じ込めない。",
  },
];
