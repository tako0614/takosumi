export interface Pillar {
  readonly title: string;
  readonly body: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: "あなたの host、 あなたの credential",
    body:
      "data も API key も、 自分のサーバーの中だけ。 SaaS にも、 こちらの kernel にも、 通り過ぎない。 self-host が default。",
  },
  {
    title: "open source、 中身が見える",
    body:
      "kernel も、 provider も、 bundled app も全部 source 公開。 動いている物が分かる。 自分で fork もできる。",
  },
  {
    title: "lock-in しない、 引っ越せる、 終わらない",
    body:
      "manifest 1 行で AWS から自宅 VM へ引っ越せる。 SaaS が止まっても、 値上げしても、 規約を変えても、 自分のものは自分のもの。",
  },
];
