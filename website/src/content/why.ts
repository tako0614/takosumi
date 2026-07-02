export interface Pillar {
  readonly title: string;
  readonly body: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: "入口は共通、実体は外部",
    body: "API、DB、object store、worker は接続先のクラウド側に作ります。Takosumi はサービス、変更履歴、状態、接続をまとめて管理します。",
  },
  {
    title: "cloud でも VM でも同じ形",
    body: "OSS は AWS、GCP、Cloudflare、Hetzner などの既存 provider をそのまま使います。scoped compatibility profile と adapter framework は Takosumi OSS の能力で、official managed targets / native backends / enforced billing は Takosumi for Operator / Cloud の運用層です。",
  },
  {
    title: "lock-in しない、引っ越せる、終わらない",
    body: "同じサービス定義に別の接続を渡せます。dev / prod / 別 cloud に移しても、変更履歴、状態、出力の扱いは変わりません。",
  },
];
