export interface Feature {
  readonly title: string;
  readonly body: string;
}

export const FEATURES: readonly Feature[] = [
  {
    title: "manifest だけ書く",
    body: "web service / DB / object store / domain を 1 つの YAML で宣言。 残りは takosumi が apply してくれる。",
  },
  {
    title: "provider を差し替える",
    body: "1 行で AWS Fargate ⇄ Cloud Run ⇄ docker-compose を行き来。 retry 設計も rollback も組み込み。",
  },
  {
    title: "credential は手元に",
    body: "AWS key も Cloudflare token も、 自分の VM の中だけ。 SaaS にも、 こちらの kernel にも漏らさない。",
  },
];
