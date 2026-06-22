/**
 * Pricing / ownership facts. Public numbers mirror the operator plan specs:
 * Starter is JPY 980/month with 1,000 credits; an extra 1,000 credit pack is
 * JPY 1,200. Stripe IDs and readiness evidence stay in operator-private state.
 */

export interface PlanFeature {
  readonly label: string;
}

export interface PricingPlan {
  readonly id: "self-host" | "platform";
  readonly name: string;
  /** Short, honest price line. Never a fabricated number. */
  readonly price: string;
  readonly priceNote: string;
  readonly tagline: string;
  readonly features: readonly PlanFeature[];
  readonly cta: { readonly label: string; readonly href: string };
  readonly highlight?: boolean;
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: "self-host",
    name: "自分で動かす (セルフホスト)",
    price: "無料",
    priceNote: "オープンソース。Takosumi への利用料はありません。",
    tagline: "あなたのインフラに、あなたが置く。",
    features: [
      {
        label:
          "自分の環境で Takosumi を動かし、deploy の設定も実行記録も自分で持つ",
      },
      {
        label: "サーバー代はあなたが直接クラウドに払う (Takosumi には払わない)",
      },
      { label: "課金画面も従量課金もなし。止める人も値上げする人もいない" },
      { label: "すべてオープンソース。中身を読める・直せる・引っ越せる" },
    ],
    cta: { label: "セルフホストガイド", href: "/docs/" },
  },
  {
    id: "platform",
    name: "Takosumi Cloud",
    price: "月額980円",
    priceNote: "1,000 credits 付き。追加 1,000 credits は 1,200円。",
    tagline: "公式ホスティング版。セットアップ不要ですぐ使えます。",
    features: [
      { label: "公式ホスティング。ブラウザからサービスを追加・更新できます" },
      { label: "クレジット制 — 実行する前に必要量を見積もって確保します" },
      { label: "まず使用量を見せるだけのモード、止めずに運用も選べます" },
      { label: "残高が足りなければ承認の前で止まり、勝手に課金されません" },
    ],
    cta: { label: "Cloud を開く", href: "https://app.takosumi.com/" },
    highlight: true,
  },
];
