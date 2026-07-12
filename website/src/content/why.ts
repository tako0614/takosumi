export interface Pillar {
  readonly title: string;
  readonly body: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: "入口はひとつ、実体はあなたのクラウド",
    body: "API・データベース・ストレージ・worker は、接続先のクラウド側に作ります。Takosumi は、サービス・変更履歴・状態・接続をまとめて管理します。",
  },
  {
    title: "クラウドでも VM でも同じ形",
    body: "OSS 版は、AWS・GCP・Cloudflare・Hetzner などの既存プロバイダーをそのまま使えます。範囲を絞った互換 API と adapter の仕組みも OSS の機能です。公式のマネージドな実行先や公式課金は、Takosumi for Operator / Cloud 側の役割です。",
  },
  {
    title: "ロックインなし、引っ越せる、終わらない",
    body: "同じサービス定義に、別の接続を渡せます。開発から本番へ、あるいは別のクラウドへ移しても、変更履歴・状態・出力の扱いは変わりません。",
  },
];
